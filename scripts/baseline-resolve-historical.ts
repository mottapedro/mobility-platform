/**
 * Baseline Historical Migration Resolver
 * 
 * Marca todas as migrations históricas anteriores ao baseline como "applied"
 * em bancos novos que já receberam o baseline SQL.
 * 
 * Uso:
 *   $env:DATABASE_URL="<url>"
 *   npx tsx scripts/baseline-resolve-historical.ts
 */

const HISTORICAL_MIGRATIONS = [
  "20260421003315_init",
  "20260422015353_add_ride_metrics",
  "20260423140951_add_driver_network",
  "20260425105032_add_ride_context",
  "20260427135402_add_waiting_referral_status",
  "20260429020039_add_driver_referral",
  "20260429021936_add_referral_index",
  "20260509000000_add_driver_referral_code",
  "20260512153000_add_driver_network_columns",
  "20260512170000_add_driver_identifier_uniques",
  "20260517000000_add_passenger_referral_network",
  "20260518000000_passenger_codes_not_null_future",
  "20260520140500_add_referral_network_indexes",
  "20260521160959_sync_driver_referral_schema",
  "20260524000000_add_is_direct_to_driver_referral",
  "20260524000001_add_operational_cutoff",
  "20260525000000_add_driver_metadata",
  "20260526000000_aliado_v2_referral_skills",
  "20260526190329_add_driver_referred_event",
  "20260527000000_aliado_v2_payment_domain",
  "20260528000000_aliado_v2_invites",
  "20260530000000_aliado_v2_ownership_enums",
  "20260531000000_restore_driver_regions_default",
  "20260601000000_add_ride_dispatch_queue_state",
  "20260601010000_add_dispatch_lifecycle_statuses",
  "20260601020000_rename_match_level_to_dispatch_stage",
  "20260612180000_expand_lifecycle_enums",
  "20260612190000_contract_lifecycle_enums",
  "20260612200000_readd_pending_to_offer_status",
  "20260612210000_add_dispatch_stage_values",
  "20260612220000_add_operational_zones",
  "20260622200000_add_settlement_root_driver_id",
  "20260701000000_add_peso_esforco_to_operational_zone",
  "20260703000000_add_pricing_fields_to_ride_request",
  "20260705000000_add_trip_execution_timestamps",
  "20260705000001_settlement_root_driver_id_nullable",
  "20260706000000_trip_execution_boundary",
  "20260720000000_gps_tracking",
  "20260720000001_pricing_snapshot",
  "20260720000002_revenue_policy",
  "20260720000003_revenue_policy_fix_code_unique",
  "20260720000004_ownership_snapshot",
  "20260720000005_ownership_policy",
];

async function main() {
  const { execSync } = await import("child_process");
  const configPath = "scripts/prisma.bootstrap.ts";
  
  let success = 0;
  let failed = 0;
  
  for (const migration of HISTORICAL_MIGRATIONS) {
    try {
      execSync(
        `npx prisma migrate resolve --config ${configPath} --applied "${migration}"`,
        { stdio: "pipe", encoding: "utf-8" }
      );
      success++;
    } catch (e: any) {
      console.error(`FAILED: ${migration} — ${e.message}`);
      failed++;
    }
  }
  
  console.log(`\n=== RESULT ===`);
  console.log(`Applied: ${success}/${HISTORICAL_MIGRATIONS.length}`);
  console.log(`Failed:  ${failed}/${HISTORICAL_MIGRATIONS.length}`);
  
  if (failed > 0) process.exit(1);
}

main();
