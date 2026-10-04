import fs from "node:fs";
import path from "node:path";
import { createTestCa, mintTestLeaf, type Pem } from "../../helpers/certs";

/** Test CA for every mock upstream; the backend trusts it through UPSTREAM_EXTRA_CA_FILE (test-only, S11). */
export async function testTls(dir: string): Promise<{ caFile: string; leaf: Pem }> {
  const ca = await createTestCa();
  const leaf = await mintTestLeaf(ca, "localhost");
  fs.mkdirSync(dir, { recursive: true });
  const caFile = path.join(dir, "ca.pem");
  fs.writeFileSync(caFile, ca.certPem);
  return { caFile, leaf };
}
