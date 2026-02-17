import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AddressInfo } from "net";

import configuration from "../../configuration";
import { StatusModule } from "./status.module";

describe("/api/status", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StatusModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/status", async () => {
    const response = await fetch(`${baseUrl}/status`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toHaveProperty("status", "HEALTHY");
    expect(payload).toHaveProperty("version", configuration.SERVER.VERSION);
    expect(payload).not.toHaveProperty("protocol");
    expect(payload).not.toHaveProperty("uptime");
  });
});
