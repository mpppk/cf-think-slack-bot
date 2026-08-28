import { describe, expect, it } from "vitest";
import {
	createSlackSignature,
	MAX_TIMESTAMP_SKEW_SECONDS,
	verifySlackSignature,
} from "./signature";

// HMAC の鍵として使うだけの固定値。Slack のドキュメントにある例(32桁のhex)を
// そのまま置くと gitleaks の generic-api-key がエントロピーで拾って CI が落ちる。
// **本物らしい形にしないこと**(検出器を黙らせるより、紛らわしい値を置かない)。
const SIGNING_SECRET = "signing-secret-for-tests-not-a-real-one";
const BODY = JSON.stringify({
	type: "event_callback",
	event: { type: "app_mention" },
});
const NOW = 1_700_000_000;

async function sign(body: string, timestamp: number, secret = SIGNING_SECRET) {
	return await createSlackSignature(secret, timestamp, body);
}

describe("verifySlackSignature", () => {
	it("正しい署名を受理する", async () => {
		const signature = await sign(BODY, NOW);
		await expect(
			verifySlackSignature({
				signingSecret: SIGNING_SECRET,
				timestamp: String(NOW),
				signature,
				body: BODY,
				nowSeconds: NOW,
			}),
		).resolves.toBe(true);
	});

	it("ボディが改竄されていれば拒否する", async () => {
		const signature = await sign(BODY, NOW);
		await expect(
			verifySlackSignature({
				signingSecret: SIGNING_SECRET,
				timestamp: String(NOW),
				signature,
				body: `${BODY} `,
				nowSeconds: NOW,
			}),
		).resolves.toBe(false);
	});

	it("別のsecretで作られた署名を拒否する", async () => {
		const signature = await sign(BODY, NOW, "another-signing-secret");
		await expect(
			verifySlackSignature({
				signingSecret: SIGNING_SECRET,
				timestamp: String(NOW),
				signature,
				body: BODY,
				nowSeconds: NOW,
			}),
		).resolves.toBe(false);
	});

	it("許容ずれを超えた古いタイムスタンプを拒否する(リプレイ対策)", async () => {
		const stale = NOW - MAX_TIMESTAMP_SKEW_SECONDS - 1;
		const signature = await sign(BODY, stale);
		await expect(
			verifySlackSignature({
				signingSecret: SIGNING_SECRET,
				timestamp: String(stale),
				signature,
				body: BODY,
				nowSeconds: NOW,
			}),
		).resolves.toBe(false);
	});

	it("許容ずれの範囲内なら受理する", async () => {
		const recent = NOW - MAX_TIMESTAMP_SKEW_SECONDS + 1;
		const signature = await sign(BODY, recent);
		await expect(
			verifySlackSignature({
				signingSecret: SIGNING_SECRET,
				timestamp: String(recent),
				signature,
				body: BODY,
				nowSeconds: NOW,
			}),
		).resolves.toBe(true);
	});

	it("ヘッダが欠落していれば拒否する", async () => {
		await expect(
			verifySlackSignature({
				signingSecret: SIGNING_SECRET,
				timestamp: null,
				signature: null,
				body: BODY,
				nowSeconds: NOW,
			}),
		).resolves.toBe(false);
	});

	it("signing secret が空なら拒否する", async () => {
		const signature = await sign(BODY, NOW);
		await expect(
			verifySlackSignature({
				signingSecret: "",
				timestamp: String(NOW),
				signature,
				body: BODY,
				nowSeconds: NOW,
			}),
		).resolves.toBe(false);
	});

	it("タイムスタンプが数値でなければ拒否する", async () => {
		const signature = await sign(BODY, NOW);
		await expect(
			verifySlackSignature({
				signingSecret: SIGNING_SECRET,
				timestamp: "not-a-number",
				signature,
				body: BODY,
				nowSeconds: NOW,
			}),
		).resolves.toBe(false);
	});
});
