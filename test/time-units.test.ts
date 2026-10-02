import assert from "node:assert/strict";
import { it } from "node:test";
import { integerUnits } from "../src/shared/time-units.ts";
it("converts decimal seconds exactly and rejects truncation", () => {
  assert.equal(integerUnits("8.001", 1000), 8001);
  assert.equal(integerUnits("1.0001", 1000), null);
  assert.equal(integerUnits("0.5", 3600), 1800);
  for (const text of ["", "1e3", "NaN", "-1", "9007199254740992"])
    assert.equal(integerUnits(text, 1), null);
});
