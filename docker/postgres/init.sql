-- PostgreSQL Initialization Script
-- This script runs automatically when the PostgreSQL container starts for the first time
-- It sets up the database with proper encoding and optional extensions

-- Set timezone to UTC for consistency
SET timezone = 'UTC';

-- Create extensions that might be useful for the application
-- UUID extension for generating unique identifiers
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Text search extension for full-text search capabilities
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Uncomment below if you need fuzzy string matching
-- CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch";

-- Create a custom function to check if the trading_app database exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'trading_app') THEN
        RAISE NOTICE 'Database trading_app does not exist yet. TypeORM will create it.';
    ELSE
        RAISE NOTICE 'Database trading_app already exists.';
    END IF;
END
$$;

-- Grant necessary permissions
-- Note: TypeORM will handle table creation through migrations
-- This script is mainly for initial setup and extensions

-- Log successful initialization
DO $$
BEGIN
    RAISE NOTICE 'PostgreSQL initialization completed successfully at %', now();
END
$$;


