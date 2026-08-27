// リポジトリ規約の機械的な検査。CI (`bun run check:conventions`) から実行する。
//
// どちらも「壊れていても他のステップが全部緑になる」種類のズレを見る。
//
//  1. シークレット名が3箇所で一致しているか
//     宣言(src/env-secrets.d.ts) / ローカル(.dev.vars.example) /
//     CI のデプロイ時同期(.github/workflows/ci.yml)。
//     ここがズレると「デプロイは成功、CIも緑、Slack からは 401」という
//     一番切り分けにくい壊れ方をする(ADR 0025)。
//
//  2. テストの命名規約(*.workers.test.ts)から外れたテストが無いか
//     vitest.config.ts の include が *.workers.test.ts に限定されているため、
//     *.test.ts で書かれたテストは**エラーも出さずに実行対象から漏れる**
//     (ADR 0022)。「書いたのに走っていない」を検出する。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const problems: string[] = [];

function read(path: string): string {
	return readFileSync(join(process.cwd(), path), "utf8");
}

function sorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort();
}

// ---- 1. シークレット名 ----------------------------------------------------

const declared = sorted(
	[
		...read("src/env-secrets.d.ts").matchAll(
			/^\s*([A-Z][A-Z0-9_]*)\?: string;$/gm,
		),
	].map((match) => match[1] as string),
);

if (declared.length === 0) {
	problems.push(
		"src/env-secrets.d.ts からシークレット宣言を1つも読み取れませんでした(書式が変わっていませんか)",
	);
}

const inExample = sorted(
	[...read(".dev.vars.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
		(match) => match[1] as string,
	),
);

if (declared.join() !== inExample.join()) {
	problems.push(
		`.dev.vars.example のシークレットが src/env-secrets.d.ts と一致しません\n` +
			`  宣言: ${declared.join(", ")}\n` +
			`  example: ${inExample.join(", ")}`,
	);
}

const workflow = read(".github/workflows/ci.yml");
// デプロイ前のシークレット同期ステップ (`jq -n --arg NAME "$NAME" ...`)
const syncedNames = [...workflow.matchAll(/--arg\s+([A-Z][A-Z0-9_]*)\s/g)].map(
	(match) => match[1] as string,
);
const syncSteps = [...workflow.matchAll(/wrangler secret bulk/g)].length;

if (syncSteps === 0) {
	problems.push(
		"ci.yml に `wrangler secret bulk` が見つかりません(シークレット同期が消えていませんか)",
	);
} else {
	if (sorted(syncedNames).join() !== declared.join()) {
		problems.push(
			`ci.yml が同期するシークレットが src/env-secrets.d.ts と一致しません\n` +
				`  宣言: ${declared.join(", ")}\n` +
				`  ci.yml: ${sorted(syncedNames).join(", ")}`,
		);
	}
	// 同期ステップが複数(preview / production)ある場合、どれか1つが取りこぼしていても
	// 名前の集合だけでは気付けないので、出現回数でも確かめる。
	if (syncedNames.length !== declared.length * syncSteps) {
		problems.push(
			`ci.yml のシークレット同期ステップに取りこぼしがあります` +
				`(${syncSteps}ステップ × ${declared.length}件 = ${declared.length * syncSteps} 個の --arg を期待、実際は ${syncedNames.length} 個)`,
		);
	}
}

// ---- 2. テストの命名規約 --------------------------------------------------

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

const strayTests = walk("src").filter(
	(path) => path.endsWith(".test.ts") && !path.endsWith(".workers.test.ts"),
);

if (strayTests.length > 0) {
	problems.push(
		`命名規約(*.workers.test.ts)から外れたテストがあります。vitest の include に該当せず、黙って実行対象から漏れます(ADR 0022):\n${strayTests
			.map((path) => `  ${path}`)
			.join("\n")}`,
	);
}

// ---- 結果 -----------------------------------------------------------------

if (problems.length > 0) {
	console.error("規約違反が見つかりました:\n");
	for (const problem of problems) console.error(`- ${problem}\n`);
	process.exit(1);
}

console.log(
	`ok: シークレット ${declared.length}件が3箇所で一致、テストの命名規約も違反なし`,
);
