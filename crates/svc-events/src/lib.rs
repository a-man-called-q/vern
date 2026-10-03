//! Events between services, over NATS JetStream.
//!
//! A service that changes data other services care about writes an event to its
//! own `outbox` table in the same transaction as the change ([`enqueue`]), so
//! either both happen or neither does. A relay task ([`spawn_relay`]) publishes
//! what is in the outbox, and a consumer ([`spawn_consumer`]) receives the events
//! another service published.
//!
//! Delivery is at least once and not strictly ordered between replicas, so:
//! - an event carries the new state of the thing and a version, not the change,
//!   and a consumer ignores an event older than what it has;
//! - a handler can run twice for one event and must reach the same result.
//!
//! JetStream drops a second message with the same `Nats-Msg-Id` inside its
//! duplicate window (two minutes by default), which covers a relay that crashed
//! between publishing and marking the row.
//!
//! The `outbox` table is the service's own: `moon generate axum -- --events`
//! writes its migration, the same table as `migrations/0001_outbox.sql` of this
//! crate, which the tests here run on.

use std::{
    env,
    sync::Arc,
    time::{Duration, Instant},
};

use async_nats::{
    HeaderMap,
    jetstream::{
        self, AckKind,
        consumer::{AckPolicy, pull},
        stream,
    },
};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde::{Serialize, de::DeserializeOwned};
use sqlx::{PgConnection, PgPool};
use thiserror::Error;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// The JetStream stream every event goes through. Its subjects are `events.>`,
/// so an event named `screen.changed` travels as `events.screen.changed`.
const STREAM: &str = "events";
const SUBJECT_PREFIX: &str = "events.";

const STREAM_KEEP: Duration = Duration::from_secs(30 * 24 * 60 * 60);

const RELAY_BATCH: i64 = 100;
const RELAY_IDLE: Duration = Duration::from_millis(200);
const RELAY_BACKOFF: Duration = Duration::from_secs(2);
const OUTBOX_PRUNE_EVERY: Duration = Duration::from_secs(600);

const RETRY_DELAY: Duration = Duration::from_secs(5);
const MAX_DELIVER: i64 = 20;

#[derive(Debug, Error)]
pub enum EventsError {
    #[error("required environment variable NATS_URL is missing")]
    MissingUrl,
    #[error("could not connect to NATS")]
    Connect(#[source] async_nats::ConnectError),
    #[error("NATS stream setup failed: {0}")]
    Stream(String),
    #[error("publishing an event failed: {0}")]
    Publish(String),
    #[error("the outbox query failed")]
    Database(#[from] sqlx::Error),
    #[error("an event payload is not valid JSON")]
    Payload(#[from] serde_json::Error),
}

/// Where the relay sends events. [`Bus`] is the real one; tests use their own.
#[async_trait]
pub trait Publisher: Send + Sync {
    /// Publishes `payload` as the event `name` and returns once the server has
    /// stored it. `id` makes a second publish of the same event a no-op.
    async fn publish(&self, name: &str, id: &str, payload: Vec<u8>) -> Result<(), EventsError>;
}

#[derive(Clone)]
pub struct Bus {
    jetstream: jetstream::Context,
}

impl Bus {
    /// Connects to `NATS_URL` and makes sure the stream exists.
    pub async fn from_env() -> Result<Self, EventsError> {
        let url = env::var("NATS_URL").map_err(|_| EventsError::MissingUrl)?;
        Self::connect(&url).await
    }

    pub async fn connect(url: &str) -> Result<Self, EventsError> {
        let client = async_nats::connect(url)
            .await
            .map_err(EventsError::Connect)?;
        let jetstream = jetstream::new(client);
        jetstream
            .get_or_create_stream(stream::Config {
                name: STREAM.to_owned(),
                subjects: vec![format!("{SUBJECT_PREFIX}>")],
                // Events are state, so a consumer that is down longer than this
                // catches up from the API instead of from the stream.
                max_age: STREAM_KEEP,
                ..Default::default()
            })
            .await
            .map_err(|error| EventsError::Stream(error.to_string()))?;
        Ok(Self { jetstream })
    }
}

#[async_trait]
impl Publisher for Bus {
    async fn publish(&self, name: &str, id: &str, payload: Vec<u8>) -> Result<(), EventsError> {
        let mut headers = HeaderMap::new();
        headers.insert(async_nats::header::NATS_MESSAGE_ID, id);
        self.jetstream
            .publish_with_headers(format!("{SUBJECT_PREFIX}{name}"), headers, payload.into())
            .await
            .map_err(|error| EventsError::Publish(error.to_string()))?
            .await
            .map_err(|error| EventsError::Publish(error.to_string()))?;
        Ok(())
    }
}

/// Writes an event to the outbox. Call it with the transaction that changes the
/// data (`&mut *tx`), so the event exists exactly when the change does.
pub async fn enqueue(
    connection: &mut PgConnection,
    name: &str,
    payload: &impl Serialize,
) -> Result<Uuid, EventsError> {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO outbox (id, name, payload) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(name)
        .bind(serde_json::to_value(payload)?)
        .execute(connection)
        .await?;
    Ok(id)
}

/// Publishes up to a batch of unpublished events, oldest first, and marks them.
/// Returns how many it published. Several replicas can run it at once: each takes
/// rows the others have not locked.
pub async fn relay_once(
    pool: &PgPool,
    publisher: &dyn Publisher,
    batch: i64,
) -> Result<usize, EventsError> {
    let mut tx = pool.begin().await?;
    let rows: Vec<(Uuid, String, serde_json::Value)> = sqlx::query_as(
        "SELECT id, name, payload FROM outbox WHERE published_at IS NULL \
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED",
    )
    .bind(batch)
    .fetch_all(&mut *tx)
    .await?;

    let mut published = Vec::with_capacity(rows.len());
    let mut failure = None;
    for (id, name, payload) in &rows {
        match publisher
            .publish(name, &id.to_string(), serde_json::to_vec(payload)?)
            .await
        {
            Ok(()) => published.push(*id),
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    if !published.is_empty() {
        sqlx::query("UPDATE outbox SET published_at = now() WHERE id = ANY($1)")
            .bind(&published)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    match failure {
        Some(error) => Err(error),
        None => Ok(published.len()),
    }
}

/// Runs the relay for the life of the process: publishes the outbox, waits when
/// it is empty, backs off when NATS or the database fails, and now and then
/// deletes rows published more than a day ago.
pub fn spawn_relay(pool: PgPool, publisher: Arc<dyn Publisher>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_prune = Instant::now();
        loop {
            match relay_once(&pool, publisher.as_ref(), RELAY_BATCH).await {
                Ok(count) if count as i64 == RELAY_BATCH => continue,
                Ok(_) => tokio::time::sleep(RELAY_IDLE).await,
                Err(error) => {
                    tracing::error!(%error, "relaying events failed");
                    tokio::time::sleep(RELAY_BACKOFF).await;
                }
            }
            if last_prune.elapsed() >= OUTBOX_PRUNE_EVERY {
                last_prune = Instant::now();
                // Rows published more than a day ago are only history.
                let pruned =
                    sqlx::query("DELETE FROM outbox WHERE published_at < now() - interval '1 day'")
                        .execute(&pool)
                        .await;
                if let Err(error) = pruned {
                    tracing::error!(%error, "pruning the outbox failed");
                }
            }
        }
    })
}

/// An event a consumer received.
pub struct Event {
    /// The event's name, such as `screen.changed`.
    pub name: String,
    /// The outbox row's ID; the same event has the same ID on every delivery.
    pub id: Option<String>,
    pub payload: Vec<u8>,
}

impl Event {
    pub fn json<T: DeserializeOwned>(&self) -> Result<T, Failure> {
        serde_json::from_slice(&self.payload)
            .map_err(|error| Failure::Drop(format!("{} has a bad payload: {error}", self.name)))
    }
}

/// Why a handler could not process an event.
#[derive(Debug)]
pub enum Failure {
    /// Try again later: the database or another service was unavailable.
    Retry(String),
    /// Never going to work (a payload that does not parse): give up on it.
    Drop(String),
}

#[async_trait]
pub trait Handler: Send + Sync + 'static {
    async fn handle(&self, event: &Event) -> Result<(), Failure>;
}

/// Receives events named `name` (a NATS subject filter without the prefix, such
/// as `screen.changed` or `campaign.*`) for as long as the process runs. `durable`
/// names the consumer: replicas of one service share it, so each event reaches
/// one of them, and it picks up where it stopped after a restart.
pub fn spawn_consumer(
    bus: Bus,
    durable: &'static str,
    name: &'static str,
    handler: impl Handler,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = consume(&bus, durable, name, &handler).await {
                tracing::error!(%error, durable, "consuming events failed");
            }
            tokio::time::sleep(RELAY_BACKOFF).await;
        }
    })
}

async fn consume(
    bus: &Bus,
    durable: &str,
    name: &str,
    handler: &dyn Handler,
) -> Result<(), EventsError> {
    let stream = bus
        .jetstream
        .get_stream(STREAM)
        .await
        .map_err(|error| EventsError::Stream(error.to_string()))?;
    let consumer = stream
        .get_or_create_consumer(
            durable,
            pull::Config {
                durable_name: Some(durable.to_owned()),
                filter_subject: format!("{SUBJECT_PREFIX}{name}"),
                ack_policy: AckPolicy::Explicit,
                max_deliver: MAX_DELIVER,
                ..Default::default()
            },
        )
        .await
        .map_err(|error| EventsError::Stream(error.to_string()))?;
    let mut messages = consumer
        .messages()
        .await
        .map_err(|error| EventsError::Stream(error.to_string()))?;

    while let Some(message) = messages.next().await {
        let message = message.map_err(|error| EventsError::Stream(error.to_string()))?;
        let event = Event {
            name: message
                .subject
                .as_str()
                .strip_prefix(SUBJECT_PREFIX)
                .unwrap_or(message.subject.as_str())
                .to_owned(),
            id: message
                .headers
                .as_ref()
                .and_then(|headers| headers.get(async_nats::header::NATS_MESSAGE_ID))
                .map(|id| id.to_string()),
            payload: message.payload.to_vec(),
        };
        let kind = match handler.handle(&event).await {
            Ok(()) => AckKind::Ack,
            Err(Failure::Retry(reason)) => {
                tracing::warn!(event = %event.name, %reason, "event handler will retry");
                AckKind::Nak(Some(RETRY_DELAY))
            }
            Err(Failure::Drop(reason)) => {
                tracing::error!(event = %event.name, %reason, "event handler gave up");
                AckKind::Term
            }
        };
        message
            .ack_with(kind)
            .await
            .map_err(|error| EventsError::Stream(error.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;
    use sqlx::PgPool;

    use super::*;

    /// Records what it is asked to publish, and can be told to fail.
    #[derive(Default)]
    struct Recording {
        sent: Mutex<Vec<(String, String, serde_json::Value)>>,
        fail_after: Option<usize>,
    }

    #[async_trait]
    impl Publisher for Recording {
        async fn publish(&self, name: &str, id: &str, payload: Vec<u8>) -> Result<(), EventsError> {
            let mut sent = self.sent.lock().expect("lock");
            if self.fail_after.is_some_and(|limit| sent.len() >= limit) {
                return Err(EventsError::Publish("down".to_owned()));
            }
            sent.push((
                name.to_owned(),
                id.to_owned(),
                serde_json::from_slice(&payload).expect("payload is JSON"),
            ));
            Ok(())
        }
    }

    async fn enqueue_in_tx(pool: &PgPool, name: &str, payload: serde_json::Value) -> Uuid {
        let mut tx = pool.begin().await.expect("begin");
        let id = enqueue(&mut tx, name, &payload).await.expect("enqueue");
        tx.commit().await.expect("commit");
        id
    }

    #[sqlx::test]
    #[ignore = "needs PostgreSQL: DATABASE_URL of an API with events"]
    async fn the_relay_publishes_in_order_and_marks_the_rows(pool: PgPool) {
        let first = enqueue_in_tx(&pool, "thing.changed", json!({ "n": 1 })).await;
        let second = enqueue_in_tx(&pool, "thing.changed", json!({ "n": 2 })).await;
        let publisher = Recording::default();

        assert_eq!(relay_once(&pool, &publisher, 100).await.expect("relay"), 2);
        {
            let sent = publisher.sent.lock().expect("lock");
            assert_eq!(
                sent[0],
                (
                    "thing.changed".to_owned(),
                    first.to_string(),
                    json!({ "n": 1 })
                )
            );
            assert_eq!(sent[1].1, second.to_string());
        }

        assert_eq!(relay_once(&pool, &publisher, 100).await.expect("relay"), 0);
    }

    #[sqlx::test]
    #[ignore = "needs PostgreSQL: DATABASE_URL of an API with events"]
    async fn an_event_rolled_back_with_its_change_is_never_published(pool: PgPool) {
        let mut tx = pool.begin().await.expect("begin");
        enqueue(&mut tx, "thing.changed", &json!({ "n": 1 }))
            .await
            .expect("enqueue");
        tx.rollback().await.expect("rollback");

        let publisher = Recording::default();
        assert_eq!(relay_once(&pool, &publisher, 100).await.expect("relay"), 0);
    }

    #[sqlx::test]
    #[ignore = "needs PostgreSQL: DATABASE_URL of an API with events"]
    async fn a_failed_publish_keeps_the_rest_for_the_next_round(pool: PgPool) {
        enqueue_in_tx(&pool, "thing.changed", json!({ "n": 1 })).await;
        enqueue_in_tx(&pool, "thing.changed", json!({ "n": 2 })).await;
        let failing = Recording {
            fail_after: Some(1),
            ..Default::default()
        };

        assert!(relay_once(&pool, &failing, 100).await.is_err());
        assert_eq!(failing.sent.lock().expect("lock").len(), 1);

        let healthy = Recording::default();
        assert_eq!(relay_once(&pool, &healthy, 100).await.expect("relay"), 1);
        assert_eq!(healthy.sent.lock().expect("lock")[0].2, json!({ "n": 2 }));
    }

    #[test]
    fn a_payload_that_does_not_parse_is_dropped_not_retried() {
        let event = Event {
            name: "thing.changed".to_owned(),
            id: None,
            payload: b"not json".to_vec(),
        };
        assert!(matches!(
            event.json::<serde_json::Value>(),
            Err(Failure::Drop(_))
        ));
    }

    struct Collect(tokio::sync::mpsc::UnboundedSender<String>);

    #[async_trait]
    impl Handler for Collect {
        async fn handle(&self, event: &Event) -> Result<(), Failure> {
            let value: serde_json::Value = event.json()?;
            let _ = self.0.send(format!("{}:{}", event.name, value["n"]));
            Ok(())
        }
    }

    // Runs against the development NATS, as starting an API does.
    #[tokio::test]
    #[ignore = "needs NATS: NATS_URL of an API with events"]
    async fn an_event_goes_through_nats_to_a_consumer() {
        let bus = Bus::from_env().await.expect("connects to NATS");
        let (sender, mut received) = tokio::sync::mpsc::unbounded_channel();
        // A consumer starts from the first event in the stream, so each run has
        // its own consumer and event name: an earlier run's events are not replayed.
        let run = Uuid::now_v7().simple().to_string();
        let durable: &'static str = Box::leak(format!("test-{run}").into_boxed_str());
        let name: &'static str = Box::leak(format!("test.round_trip.{run}").into_boxed_str());
        spawn_consumer(bus.clone(), durable, name, Collect(sender));

        let id = Uuid::now_v7().to_string();
        let payload = serde_json::to_vec(&json!({ "n": 7 })).expect("json");
        bus.publish(name, &id, payload.clone())
            .await
            .expect("publish");
        // The same ID again is dropped by the server.
        bus.publish(name, &id, payload).await.expect("publish");

        let got = tokio::time::timeout(Duration::from_secs(10), received.recv())
            .await
            .expect("the event arrives")
            .expect("channel open");
        assert_eq!(got, format!("{name}:7"));
        assert!(
            tokio::time::timeout(Duration::from_millis(500), received.recv())
                .await
                .is_err(),
            "the duplicate was delivered"
        );
    }
}
