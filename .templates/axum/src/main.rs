{% if worker -%}
use thiserror::Error;
{% if events %}
mod events;
{% endif %}
// This worker serves no API and checks no token, so it has no ZITADEL
// application. What it shares with the project's APIs is in the crates of
// crates/: how it starts and stops (svc-boot), /healthz (svc-http){% if database %}, its
// database (svc-db){% endif %}{% if events %}, and its events (svc-events){% endif %}.
{% if events %}
/// The name of this worker's consumer on the bus. Its replicas share it, and it
/// resumes where it stopped after a restart.
const CONSUMER: &str = "{{ name | kebab_case }}";
{% endif %}
#[derive(Debug, Error)]
enum StartupError {
{% if database %}    #[error(transparent)]
    Database(#[from] svc_db::DbError),
{% endif %}{% if events %}    #[error(transparent)]
    Events(#[from] svc_events::EventsError),
{% endif %}    #[error(transparent)]
    Boot(#[from] svc_boot::BootError),
}

#[tokio::main]
async fn main() -> Result<(), StartupError> {
    svc_boot::init();

{% if events %}    // The files of migrations/ are embedded here, and applied before the work starts.
    let pool = svc_db::connect(&sqlx::migrate!()).await?;
    let bus = svc_events::Bus::from_env().await?;
    // What this worker writes to its outbox reaches the other services.
    svc_events::spawn_relay(pool.clone(), std::sync::Arc::new(bus.clone()));
    // The work: every event with this name reaches one replica of this worker.
    // Name the events it handles, and add a consumer for each kind of work.
    svc_events::spawn_consumer(bus, CONSUMER, "example.*", events::Record { pool });
{% elif database %}    // The files of migrations/ are embedded here, and applied before the work starts.
    // Give the pool to the tasks that do this worker's work.
    let _pool = svc_db::connect(&sqlx::migrate!()).await?;
{% else %}    // Start this worker's tasks here, with `tokio::spawn`.
{% endif %}
    // Only /healthz is served, so a probe can tell that the process is alive.
    // This returns on SIGTERM, and the tasks stop with the process.
    svc_boot::serve(svc_http::health::health_router()).await?;
    Ok(())
}
{%- else -%}
use thiserror::Error;

mod app;
{% if database %}mod notes;
{% endif %}
// What this API shares with the others is in the crates of crates/: who is
// calling (svc-auth), what it answers with (svc-http), how it starts and stops
// (svc-boot){% if database %}, its database (svc-db){% endif %}{% if events %}, and its events (svc-events){% endif %}.

#[derive(Debug, Error)]
enum StartupError {
    #[error(transparent)]
    Config(#[from] svc_auth::ConfigError),
    #[error(transparent)]
    Auth(#[from] svc_auth::AuthSetupError),
{% if database %}    #[error(transparent)]
    Database(#[from] svc_db::DbError),
{% endif %}{% if events %}    #[error(transparent)]
    Events(#[from] svc_events::EventsError),
{% endif %}    #[error(transparent)]
    Boot(#[from] svc_boot::BootError),
}

#[tokio::main]
async fn main() -> Result<(), StartupError> {
    svc_boot::init();

    let config = svc_auth::Config::from_env()?;
{% if database %}    // The files of migrations/ are embedded here, and applied before the API listens.
    let pool = svc_db::connect(&sqlx::migrate!()).await?;
{% endif %}{% if events %}    let bus = svc_events::Bus::from_env().await?;
    svc_events::spawn_relay(pool.clone(), std::sync::Arc::new(bus.clone()));
{% endif %}    let app = app::router(svc_auth::AppState::from_config(config)?);
{% if database %}    let app = app.layer(axum::Extension(pool));
{% endif %}{% if events %}    let app = app.layer(axum::Extension(bus));
{% endif %}    svc_boot::serve(app).await?;
    Ok(())
}
{%- endif %}
