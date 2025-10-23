import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Vortex Integration (e2e, smoke)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close?.();
  });

  it('health endpoints respond and include vortexHttp field', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body?.services?.vortexHttp).toBeDefined();

    const res2 = await request(app.getHttpServer()).get('/health/detailed').expect(200);
    expect(res2.body?.services?.vortexHttp).toBeDefined();
  });
});


