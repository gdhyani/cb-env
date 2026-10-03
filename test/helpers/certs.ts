import "reflect-metadata";
import { randomBytes } from "node:crypto";
import * as x509 from "@peculiar/x509";

const webcrypto = globalThis.crypto;
x509.cryptoProvider.set(webcrypto);
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

export interface Pem {
  certPem: string;
  keyPem: string;
}

const keyPem = async (k: CryptoKey) =>
  x509.PemConverter.encode(await webcrypto.subtle.exportKey("pkcs8", k), "PRIVATE KEY");

export async function createTestCa(): Promise<Pem> {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${randomBytes(8).toString("hex")}`,
    name: "CN=cb-env test CA",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });
  return { certPem: cert.toString("pem"), keyPem: await keyPem(keys.privateKey) };
}

export async function mintTestLeaf(ca: Pem, host: string): Promise<Pem> {
  const caCert = new x509.X509Certificate(ca.certPem);
  const [der] = x509.PemConverter.decode(ca.keyPem);
  const signingKey = await webcrypto.subtle.importKey("pkcs8", der as ArrayBuffer, ALG, false, ["sign"]);
  const keys = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: `01${randomBytes(8).toString("hex")}`,
    subject: `CN=${host}`,
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey,
    extensions: [
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    ],
  });
  return { certPem: cert.toString("pem"), keyPem: await keyPem(keys.privateKey) };
}
