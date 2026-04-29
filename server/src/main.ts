import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation pipe — applies to all DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,         // Strip unknown fields
      forbidNonWhitelisted: true,
      transform: true,         // Auto-transform to DTO types
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  // Swagger / OpenAPI
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Time-Off Microservice')
    .setDescription('Manages time-off request lifecycle and HCM balance synchronization')
    .setVersion('1.0.0')
    .addTag('Balances')
    .addTag('Time-Off Requests')
    .addTag('HCM Sync')
    .addTag('Health')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(`\n🚀  Time-Off Microservice running on http://localhost:${port}`);
  console.log(`📖  Swagger docs at http://localhost:${port}/api/docs\n`);
}

bootstrap();