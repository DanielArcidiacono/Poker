import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { POST as activate } from "../src/app/api/agent/activate/route";
import { DELETE as deenroll } from "../src/app/api/agent/deenroll/route";
import { POST as enroll } from "../src/app/api/agent/enroll/route";
import { GET as downloadInstaller } from "../src/app/api/install-agent/raw/route";
import { POST as verify } from "../src/app/api/agent/verify/route";
import { hashAgentCredential } from "../src/lib/auth";
import {
  createInstallToken,
  parseInstallToken,
} from "../src/lib/install-token";
import { getStore } from "../src/lib/store";

test("saved session credentials verify without creating an active session", async () => {
  process.env.PROSTAR_ENROLLMENT_SECRET = "v".repeat(48);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const clientId = randomUUID();
  const credential = `saved-${"x".repeat(40)}`;
  const store = getStore();
  await store.enrollSession(
    clientId,
    hashAgentCredential(credential),
  );

  const request = (bearer: string) =>
    new Request("http://dashboard.test/api/agent/verify", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientId }),
    });

  assert.equal((await verify(request(credential))).status, 204);
  assert.equal(
    (await verify(request("wrong-credential-that-is-long-enough"))).status,
    401,
  );
  assert.equal((await store.getSession(clientId)).online, false);
  assert.equal(
    (await store.listSessions()).some((session) => session.id === clientId),
    false,
  );
});

test("downloading setup is side-effect free and setup can activate then revoke a session", async () => {
  process.env.PROSTAR_ENROLLMENT_SECRET = "e".repeat(48);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const token = createInstallToken();
  const claim = parseInstallToken(token);
  assert.ok(claim);
  const credential = `local-${"s".repeat(48)}`;
  const store = getStore();

  const download = await downloadInstaller(
    new Request(`https://dashboard.test/api/install-agent/raw?token=${token}`),
  );
  assert.equal(download.status, 200);
  const downloadedScript = await download.text();
  assert.equal(
    downloadedScript.includes(Buffer.from(token).toString("base64")),
    true,
  );
  assert.equal(downloadedScript.includes(credential), false);
  assert.equal(
    downloadedScript.includes(Buffer.from(credential).toString("base64")),
    false,
  );
  assert.equal(
    await store.verifySessionCredential(
      claim.clientId,
      hashAgentCredential(credential),
    ),
    false,
  );

  const enrollmentRequest = () =>
    new Request("https://dashboard.test/api/agent/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        credentialHash: hashAgentCredential(credential),
      }),
    });
  assert.equal((await enroll(enrollmentRequest())).status, 204);
  assert.equal(
    (await enroll(enrollmentRequest())).status,
    204,
    "the same install can safely retry an ambiguous enrollment response",
  );
  const conflictingRequest = new Request(
    "https://dashboard.test/api/agent/enroll",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        credentialHash: hashAgentCredential(`other-${"z".repeat(48)}`),
      }),
    },
  );
  assert.equal(
    (await enroll(conflictingRequest)).status,
    409,
    "a second execution must not acquire another install's cleanup",
  );

  const scopedRequest = (url: string, method: "POST" | "DELETE") =>
    new Request(url, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientId: claim.clientId }),
    });

  assert.equal(
    (
      await deenroll(
        scopedRequest(
          "https://dashboard.test/api/agent/deenroll",
          "DELETE",
        ),
      )
    ).status,
    204,
  );
  assert.equal((await enroll(enrollmentRequest())).status, 204);

  const wrongCredentialRequest = new Request(
    "https://dashboard.test/api/agent/deenroll",
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer wrong-${"w".repeat(48)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientId: claim.clientId }),
    },
  );
  assert.equal((await deenroll(wrongCredentialRequest)).status, 401);

  assert.equal(
    (
      await activate(
        scopedRequest(
          "https://dashboard.test/api/agent/activate",
          "POST",
        ),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await deenroll(
        scopedRequest(
          "https://dashboard.test/api/agent/deenroll",
          "DELETE",
        ),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await deenroll(
        scopedRequest(
          "https://dashboard.test/api/agent/deenroll",
          "DELETE",
        ),
      )
    ).status,
    204,
    "revocation is idempotent when the scoped credential is already absent",
  );
  assert.equal(
    (
      await verify(
        scopedRequest("https://dashboard.test/api/agent/verify", "POST"),
      )
    ).status,
    401,
  );
});
