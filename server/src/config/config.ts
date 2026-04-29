import { registerAs } from '@nestjs/config';
import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  DATABASE_PATH: Joi.string().default('./timeoff.sqlite'),
  WEBHOOK_SECRET: Joi.string().required(),
  HCM_BASE_URL: Joi.string().uri().required(),
  OUTBOX_POLL_INTERVAL_MS: Joi.number().default(5000),
  OUTBOX_MAX_RETRIES: Joi.number().default(5),
  BALANCE_CACHE_TTL_SECONDS: Joi.number().default(300),
  WEBHOOK_MAX_AGE_SECONDS: Joi.number().default(300),
});

export const appConfig = registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databasePath: process.env.DATABASE_PATH ?? './timeoff.sqlite',
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'super-secret-hmac-key-change-in-prod',
  hcmBaseUrl: process.env.HCM_BASE_URL ?? 'http://localhost:4000',
  outboxPollIntervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS ?? '5000', 10),
  outboxMaxRetries: parseInt(process.env.OUTBOX_MAX_RETRIES ?? '5', 10),
  balanceCacheTtlSeconds: parseInt(process.env.BALANCE_CACHE_TTL_SECONDS ?? '300', 10),
  webhookMaxAgeSeconds: parseInt(process.env.WEBHOOK_MAX_AGE_SECONDS ?? '300', 10),
}));