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
