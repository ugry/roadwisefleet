// Environment configuration — one place, fail-fast on missing vars.
export const env = {
  PORT: Number(process.env.PORT || 8080),
  HOST: process.env.HOST || '127.0.0.1',
  DATABASE_URL:
    process.env.DATABASE_URL ||
    'postgresql://roadwisefleet:roadwisefleet@127.0.0.1:5432/roadwisefleet',
};
