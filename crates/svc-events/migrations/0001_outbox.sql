-- Events waiting to be published to NATS. They are written in the same
-- transaction as the change they describe (svc_events::enqueue), and the relay
-- publishes them, oldest first. id is a UUID v7, so it sorts by time, and it
-- doubles as the message ID that lets NATS drop a duplicate.

CREATE TABLE outbox (
    id           uuid        PRIMARY KEY,
    name         text        NOT NULL,
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);

-- The relay's query reads only what is still waiting.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
