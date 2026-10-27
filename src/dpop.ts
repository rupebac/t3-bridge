import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

export const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const curveOrder = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

export interface PublicJwk {
  crv: string;
  kty: string;
  x: string;
  y: string;
}

export function generateDpopKey(): Record<string, string> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ format: "jwk" }) as Record<string, string>;
}

export class Dpop {
  private readonly key: KeyObject;
  readonly publicJwk: PublicJwk;
  readonly thumbprint: string;

  constructor(privateJwk: Record<string, string>) {
    this.key = createPrivateKey({ key: privateJwk, format: "jwk" });
    const exported = createPublicKey(this.key).export({ format: "jwk" }) as PublicJwk;
    this.publicJwk = { crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y };
    this.thumbprint = hash(JSON.stringify(this.publicJwk));
  }

  proof(method: string, target: string, accessToken?: string): string {
    const url = new URL(target);
    url.search = "";
    url.hash = "";
    const claims: Record<string, unknown> = {
      htm: method.toUpperCase(),
      htu: url.toString(),
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
    };
    if (accessToken) claims.ath = hash(accessToken);
    const input = `${encode({ typ: "dpop+jwt", alg: "ES256", jwk: this.publicJwk })}.${encode(claims)}`;
    const signature = sign("sha256", Buffer.from(input), { key: this.key, dsaEncoding: "ieee-p1363" });
    const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
    if (s > curveOrder / 2n) {
      Buffer.from((curveOrder - s).toString(16).padStart(64, "0"), "hex").copy(signature, 32);
    }
    return `${input}.${signature.toString("base64url")}`;
  }
}
