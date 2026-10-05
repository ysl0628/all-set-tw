import { afterEach, describe, expect, it } from "vitest";
import { resolveClassifications } from "../../../src/features/classification/service";
import { createTestD1 } from "../../helpers/d1";

let dispose: (() => Promise<void>) | undefined;

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("信用卡繳費分類", () => {
  it("繳卡費歸入獨立分類並排除統計，手動改入此分類也排除", async () => {
    const { binding, mf } = await createTestD1();
    dispose = () => mf.dispose();
    await binding
      .prepare(
        `INSERT INTO classification_overrides
           (id, target_type, target_id, category_id, created_at, updated_at)
         VALUES ('override-1', 'bank_transaction', 'manual', 'card-payment',
           '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z')`,
      )
      .run();

    const result = await resolveClassifications(binding, [
      { id: "deposit", sourceId: "s1", description: "玉山信用卡自扣" },
      { id: "card", sourceId: "s2", description: "繳款入帳－謝謝" },
      { id: "manual", sourceId: "s3", description: "合成交易" },
      { id: "shop", sourceId: "s4", description: "全聯福利中心" },
    ]);

    for (const id of ["deposit", "card", "manual"]) {
      expect(result.get(id)).toMatchObject({
        categoryId: "card-payment",
        label: "信用卡繳費",
        excludedFromCalculation: true,
      });
    }
    expect(result.get("shop")?.categoryId).toBe("shopping");
    expect(result.get("shop")?.excludedFromCalculation).toBeFalsy();
  }, 60_000);
});
