import { MongoClient } from "mongodb";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server-core";

/** MongoDB replica set with auth: the "real" upstream; the app user exists only here and in the backend (encrypted). */
export async function startUpstreamMongo(password: string) {
  const rs = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: "wiredTiger",
      auth: { enable: true, customRootName: "root", customRootPwd: password },
    },
  });
  const host = new URL(rs.getUri()).host;
  const name = rs.replSetOpts.name;
  const admin = new MongoClient(
    `mongodb://root:${encodeURIComponent(password)}@${host}/?authSource=admin&replicaSet=${name}`,
  );
  await admin
    .db("admin")
    .command({ createUser: "shop_app", pwd: password, roles: [{ role: "readWrite", db: "shop" }] });
  await admin.close();
  return {
    uri: `mongodb://shop_app:${encodeURIComponent(password)}@${host}/shop?authSource=admin&replicaSet=${name}`,
    stop: async () => void (await rs.stop()),
  };
}

/** The backend's own database (no secrets of interest). */
export async function startBackendMongo() {
  const server = await MongoMemoryServer.create();
  return { uri: server.getUri("cb_e2e"), stop: async () => void (await server.stop()) };
}

/** docker-compose.test.yml services (cb-backend), addressed by their published ports. */
export function composeServices(password: string, redisPassword: string) {
  const enc = encodeURIComponent(password);
  return {
    pg: `postgresql://shop_admin:${enc}@127.0.0.1:5433/shop`,
    mysql: `mysql://shop_admin:${enc}@127.0.0.1:3307/shop`,
    redis: `redis://:${encodeURIComponent(redisPassword)}@127.0.0.1:6380`,
    smtp: `smtp://shop_mailer:${enc}@127.0.0.1:1026`,
    s3: { endpoint: "http://127.0.0.1:9010", accessKeyId: "shopadmin", secretAccessKey: password },
  };
}
