//! The database of an API: its pool, with the API's migrations applied, and what
//! a handler answers when a query fails.

use std::{env, time::Duration};

use sqlx::{PgPool, migrate::Migrator, postgres::PgPoolOptions};
use svc_http::ApiError;
use thiserror::Error;

const MAX_CONNECTIONS: u32 = 10;
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Error)]
pub enum DbError {
    #[error("required environment variable DATABASE_URL is missing")]
    MissingUrl,
    #[error("could not connect to the database")]
    Connect(#[source] sqlx::Error),
    #[error("could not apply the database migrations")]
    Migrate(#[source] sqlx::migrate::MigrateError),
}

/// Connects to `DATABASE_URL` and applies `migrations`. The migrations are the
/// API's own: `sqlx::migrate!()` embeds the files of the crate that calls it, so
/// the API passes them in (`svc_db::connect(&sqlx::migrate!()).await?`).
pub async fn connect(migrations: &Migrator) -> Result<PgPool, DbError> {
    let url = env::var("DATABASE_URL").map_err(|_| DbError::MissingUrl)?;
    let pool = PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(ACQUIRE_TIMEOUT)
        .connect(&url)
        .await
        .map_err(DbError::Connect)?;
    migrations.run(&pool).await.map_err(DbError::Migrate)?;
    Ok(pool)
}

/// Logs the cause and answers with a generic 500, so SQL details stay
/// server-side: `.await.map_err(database_error)?`.
pub fn database_error(error: sqlx::Error) -> ApiError {
    tracing::error!(%error, "database query failed");
    ApiError::Internal
}

#[cfg(test)]
mod tests {
    use sqlx::migrate::Migrator;

    // Runs against the development database of an API, as starting that API
    // does: its `test` task runs this with its own DATABASE_URL.
    #[tokio::test]
    #[ignore = "needs PostgreSQL: DATABASE_URL of an API with a database"]
    async fn connect_gives_a_pool_that_answers() {
        // The database has the API's migrations, which this crate does not know.
        let mut none = Migrator::DEFAULT;
        none.set_ignore_missing(true);
        let pool = super::connect(&none).await.expect("connects and migrates");
        let (one,): (i32,) = sqlx::query_as("SELECT 1")
            .fetch_one(&pool)
            .await
            .expect("the database answers");
        assert_eq!(one, 1);
    }
}
