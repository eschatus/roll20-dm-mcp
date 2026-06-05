// End-to-end smoke test of the browserless bridge: exercise the real dndbeyond.ts functions
// (not raw fetch) so routing + monster-service mapping + JWT caching all run for real.
import * as ddb from "../bridge/dndbeyond.js";

async function main() {
  console.error(`DDB_TRANSPORT=${process.env.DDB_TRANSPORT || "(default rt)"}\n`);

  console.error("— getMonster('goblin') —");
  const goblin = await ddb.getMonster("goblin");
  console.error(`  ${goblin.name}  AC ${goblin.armorClass}  HP ${goblin.averageHitPoints}  CR ${goblin.challengeRating}  speed=${JSON.stringify(goblin.speed)}`);
  console.error(`  abilities[:160]: ${ddb.getMonsterAbilities(goblin).replace(/\n/g, " ").slice(0, 160)}`);
  console.error(`  scores: ${JSON.stringify(ddb.getMonsterAbilityScores(goblin))}\n`);

  console.error("— getMonster(16927) by id —");
  const byId = await ddb.getMonster(16927);
  console.error(`  ${byId.name}  AC ${byId.armorClass}  CR ${byId.challengeRating}\n`);

  console.error("— getCharacterStats(142697619) Zeno —");
  const stats = await ddb.getCharacterStats(142697619);
  console.error(`  ${stats.name}  L${stats.level} ${stats.classes}  AC ${stats.armorClass}  HP ${stats.hp.current}/${stats.hp.max}  PP ${stats.passivePerception}\n`);

  console.error("— getCampaignCharacters(7469632) —");
  const chars = await ddb.getCampaignCharacters("7469632");
  console.error(`  ${chars.length} chars: ${chars.map((c) => `${c.characterName}(${c.id})`).join(", ")}`);
}
main().then(() => process.exit(0), (e) => { console.error("SMOKE FAILED:", e); process.exit(1); });
