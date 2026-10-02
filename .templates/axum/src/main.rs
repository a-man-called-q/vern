use std::net::SocketAddr;

use thiserror::Error;
use tracing_subscriber::EnvFilter;

mod app;
mod auth;
mod config;
{% if database %}mod db;
{% endif %}mod error;
{% if events %}mod events;
{% endif %}{% if database %}mod notes;
{% endif %}
#[derive(Debug, Error)]
enum StartupError {
    #[error(transparent)]
    Config(#[from] config::ConfigError),
    #[error(transparent)]
    Auth(#[from] auth::AuthSetupError),
{% if database %}    #[error(transparent)]
    Database(#[from] db::DbError),
{% endif %}{% if events %}    #[error(transparent)]
    Events(#[from] events::EventsError),
{% endif %}    #[error("invalid bind address: {0}")]
    BindAddress(#[from] std::net::AddrParseError),
    #[error("failed to bind API listener: {0}")]
    Bind(#[from] std::io::Error),
    #[error("PORT must be set")]
    MissingPort,
    #[error("PORT must be an integer between 1 and 65535")]
    InvalidPort(#[source] std::num::ParseIntError),
    #[error("PORT must be an integer between 1 and 65535")]
    PortOutOfRange,
}

#[tokio::main]
async fn main() -> Result<(), StartupError> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = config::Config::from_env()?;
{% if database %}    let pool = db::connect().await?;
{% endif %}{% if events %}    let bus = events::Bus::from_env().await?;
    events::spawn_relay(pool.clone(), std::sync::Arc::new(bus.clone()));
{% endif %}    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = std::env::var("PORT").map_err(|_| StartupError::MissingPort)?;
    let port = port.parse::<u16>().map_err(StartupError::InvalidPort)?;
    if port == 0 {
        return Err(StartupError::PortOutOfRange);
    }
    let bind_address: SocketAddr = format!("{host}:{port}").parse()?;
    let app = app::router(auth::AppState::from_config(config)?){% if database %}.layer(axum::Extension(pool)){% endif %}{% if events %}.layer(axum::Extension(bus)){% endif %};
    let listener = tokio::net::TcpListener::bind(bind_address).await?;
    tracing::info!(address = %listener.local_addr()?, "API server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(StartupError::Bind)
}

/// Resolves on Ctrl-C or SIGTERM, which `docker stop` and Kubernetes send before
/// they stop the container. The server then stops accepting connections and
/// finishes the requests in flight.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "cannot listen for Ctrl-C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down: finishing the requests in flight");
}
