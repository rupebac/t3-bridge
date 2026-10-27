import { createHash, createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Dpop, generateDpopKey } from "../src/dpop.js";

const curveOrder = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const privateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "g9woUmX-tGZOOBGn-oO-63hjuoDDpWvy7mjv0Sst7OA",
  y: "KqxPqepVYagENTxv5uOFybVxTFMmS0et4E4PhJnJKN8",
  d: "Uhc-iS0p4bQhUumukxjbreQdu41QXzEZfTqHqZW2JGE",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

test("DPoP proofs from a fixed key are low-S ES256 and bind the access token", () => {
  const signer = new Dpop(privateJwk);
  const again = new Dpop(privateJwk);
  assert.equal(signer.thumbprint, again.thumbprint);
  assert.equal("d" in signer.publicJwk, false);
  assert.deepEqual(Object.keys(signer.publicJwk).sort(), ["crv", "kty", "x", "y"]);
  assert.equal(signer.thumbprint, sha256(JSON.stringify(signer.publicJwk)));

  const proof = signer.proof("post", "https://relay.t3.codes/v1/client/dpop-token?drop=1#frag", "relay-token");
  const [encodedHeader, encodedPayload, encodedSignature] = proof.split(".");
  assert.equal(encodedHeader && encodedPayload && encodedSignature && proof.split(".").length, 3);
  const header = JSON.parse(Buffer.from(encodedHeader!, "base64url").toString()) as {
    alg: string;
    typ: string;
    jwk: Record<string, string>;
  };
  const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString()) as {
    htm: string;
    htu: string;
    iat: number;
    jti: string;
    ath?: string;
  };
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "dpop+jwt");
  assert.equal(header.jwk.d, undefined);
  assert.equal(payload.htm, "POST");
  assert.equal(payload.htu, "https://relay.t3.codes/v1/client/dpop-token");
  assert.equal(payload.ath, sha256("relay-token"));
  assert.ok(Math.abs(Date.now() / 1000 - payload.iat) < 10);
  const signature = Buffer.from(encodedSignature!, "base64url");
  assert.equal(signature.length, 64);
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  assert.ok(s <= curveOrder / 2n);
  assert.equal(verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    signature,
  ), true);
  const second = signer.proof("GET", "https://relay.t3.codes/v1/environments");
  const secondPayload = JSON.parse(Buffer.from(second.split(".")[1]!, "base64url").toString()) as { jti: string; ath?: string };
  assert.notEqual(secondPayload.jti, payload.jti);
  assert.equal(secondPayload.ath, undefined);
});

test("generateDpopKey can sign a proof", () => {
  const signer = new Dpop(generateDpopKey());
  const proof = signer.proof("POST", "http://127.0.0.1:9/oauth/token");
  assert.equal(proof.split(".").length, 3);
  assert.equal(signer.publicJwk.crv, "P-256");
});
