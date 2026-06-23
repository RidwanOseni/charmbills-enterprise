use charms_sdk::data::{
    charm_values, sum_token_amount, App, Data, Transaction, UtxoId, B32, NFT, TOKEN,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;

#[cfg(feature = "wasm-bridge")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm-bridge")]
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[cfg(feature = "wasm-bridge")]
#[derive(Deserialize)]
pub struct BridgeVariables {
    pub type_name: String,
    pub anchor_utxo: Option<String>,
    pub funding_utxo: String,
    pub salary_utxo: Option<String>,
    pub ticker: Option<String>,
    pub remaining: Option<String>,
    pub metadata_hash: Option<String>,
    pub scroll_policy: Option<String>,
    pub pay_period_seconds: Option<String>,
    pub compensation_sats: Option<String>,
    pub treasury_dest: String,
    pub app_id: String,
    pub app_vk: String,
    pub authority_utxo: Option<String>,
    pub authority_utxos: Option<Vec<String>>,
    pub worker_dests: Option<Vec<String>>,
    pub token_amounts: Option<Vec<String>>,
    pub has_treasury_change: Option<bool>,
    pub treasury_change_sats: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NftContent {
    pub ticker: String,
    pub remaining: u64,
    pub metadata_hash: String,
    pub scroll_policy: u8,
    pub pay_period_seconds: u64,
    pub compensation_sats: u64,
}

impl NftContent {
    pub fn validate(&self) -> bool {
        if self.ticker.is_empty() {
            return false;
        }
        if self.metadata_hash.is_empty() {
            return false;
        }
        if self.pay_period_seconds == 0 {
            return false;
        }
        if self.scroll_policy > 1 {
            return false;
        }
        if self.compensation_sats < 1000 {
            return false;
        }
        true
    }

    pub fn is_time_based(&self) -> bool {
        self.scroll_policy == 0
    }

    pub fn is_proof_based(&self) -> bool {
        self.scroll_policy == 1
    }
}

pub fn app_contract(app: &App, tx: &Transaction, _x: &Data, w: &Data) -> bool {
    let _ = _x.bytes();
    match app.tag {
        NFT => nft_contract_satisfied(app, tx, w),
        TOKEN => token_contract_satisfied(app, tx),
        _ => false,
    }
}

fn nft_contract_satisfied(app: &App, tx: &Transaction, w: &Data) -> bool {
    let w_str = match w.value::<String>() {
        Ok(val) => {
            eprintln!("\n--- [ZK-DEBUG] NFT Contract Debug ---");
            eprintln!("Witness (w_str): {:?}", val);
            eprintln!("Expected App Identity: {:?}", app.identity.to_string());
            val
        }
        Err(e) => {
            eprintln!("❌ Error: Failed to decode witness as String: {:?}", e);
            return false;
        }
    };

    let witness_hash = hash(&w_str);
    eprintln!("Witness Hash: {:?}", witness_hash.to_string());
    eprintln!("App Identity:  {:?}", app.identity.to_string());

    if witness_hash != app.identity {
        eprintln!("❌ Error: Witness hash does not match App Identity!");
        eprintln!("   Expected: {}", app.identity.to_string());
        eprintln!("   Got:      {}", witness_hash.to_string());
        return false;
    }
    eprintln!("✅ Witness hash matches App Identity");

    let w_utxo_id = match UtxoId::from_str(&w_str) {
        Ok(id) => {
            eprintln!("✅ Parsed witness as UTXO ID: {:?}", id);
            id
        }
        Err(e) => {
            eprintln!("⚠️  Witness is not a valid UTXO ID (this may be fine): {:?}", e);
            return false;
        }
    };

    let is_nft_minting = tx.ins.iter().any(|(utxo_id, _)| utxo_id == &w_utxo_id);
    eprintln!("Is NFT Minting Transaction: {}", is_nft_minting);

    if is_nft_minting {
        if !tx.ins.iter().any(|(utxo_id, _)| utxo_id == &w_utxo_id) {
            eprintln!("❌ Error: Witness UTXO not found in transaction inputs");
            return false;
        }
        eprintln!("✅ Witness UTXO found in transaction inputs");
    }

    let nft_outputs: Vec<&Data> = charm_values(app, tx.outs.iter()).collect();
    eprintln!("NFT Outputs found: {}", nft_outputs.len());

    if nft_outputs.is_empty() {
        eprintln!("❌ Error: No NFT outputs found");
        return false;
    }

    if is_nft_minting && nft_outputs.len() != 1 {
        eprintln!("❌ Error: NFT minting requires exactly 1 NFT output, got {}", nft_outputs.len());
        return false;
    }

    for (i, data) in nft_outputs.iter().enumerate() {
        let content: NftContent = match data.value() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("❌ Error: Failed to decode NFT content at index {}: {:?}", i, e);
                return false;
            }
        };

        eprintln!("NFT Output {}: ticker={}, remaining={}, scrollPolicy={}",
                  i, content.ticker, content.remaining, content.scroll_policy);

        if !content.validate() {
            eprintln!("❌ Error: NFT content validation failed at index {}", i);
            return false;
        }

        if is_nft_minting && i == 0 {
            if content.ticker.is_empty() {
                eprintln!("❌ Error: NFT ticker is empty");
                return false;
            }
            eprintln!("✅ NFT content validated successfully");
        }
    }

    eprintln!("✅ NFT Contract Satisfied!\n");
    true
}

fn token_contract_satisfied(token_app: &App, tx: &Transaction) -> bool {
    eprintln!("\n--- [ZK-DEBUG] Token Contract Debug ---");

    let has_nft_input = tx.ins.iter().any(|(_, v)| {
        charm_values(&App { tag: NFT, identity: token_app.identity.clone(), vk: token_app.vk.clone() }, std::iter::once(v))
            .next()
            .is_some()
    });

    let has_token_input = tx.ins.iter().any(|(_, v)| {
        charm_values(token_app, std::iter::once(v))
            .next()
            .is_some()
    });

    eprintln!("Has NFT input: {}", has_nft_input);
    eprintln!("Has Token input: {}", has_token_input);

    if has_nft_input {
        eprintln!("✅ Detected NFT minting transaction");
        return can_mint_token(token_app, tx);
    }

    if has_token_input {
        eprintln!("✅ Detected Scroll settlement transaction");
        return validate_scroll_release(token_app, tx);
    }

    eprintln!("❌ Error: Transaction has no valid NFT or Token inputs");
    false
}

fn can_mint_token(token_app: &App, tx: &Transaction) -> bool {
    eprintln!("\n--- [ZK-DEBUG] Token Mint Start ---");

    let nft_app = App {
        tag: NFT,
        identity: token_app.identity.clone(),
        vk: token_app.vk.clone(),
    };

    let nft_inputs: Vec<NftContent> = charm_values(&nft_app, tx.ins.iter().map(|(_, v)| v))
        .filter_map(|data| data.value::<NftContent>().ok())
        .collect();

    if nft_inputs.is_empty() {
        eprintln!("❌ Error: No NFT found in inputs for ID: {}", nft_app.identity);
        return false;
    }

    let nft_in = &nft_inputs[0];
    let incoming_supply = nft_in.remaining;
    eprintln!("✅ Incoming Supply: {}", incoming_supply);

    let nft_outputs: Vec<NftContent> = charm_values(&nft_app, tx.outs.iter())
        .filter_map(|data| data.value::<NftContent>().ok())
        .collect();

    if nft_outputs.is_empty() {
        eprintln!("❌ Error: No NFT found in outputs");
        return false;
    }

    let nft_out = &nft_outputs[0];
    let outgoing_supply = nft_out.remaining;
    eprintln!("✅ Outgoing Supply: {}", outgoing_supply);

    if incoming_supply < outgoing_supply {
        eprintln!("❌ Error: Supply increased ({} < {})", incoming_supply, outgoing_supply);
        return false;
    }

    let tokens_to_mint = incoming_supply - outgoing_supply;

    let input_tokens = match sum_token_amount(token_app, tx.ins.iter().map(|(_, v)| v)) {
        Ok(amount) => amount,
        Err(_) => 0,
    };

    let output_tokens = match sum_token_amount(token_app, tx.outs.iter()) {
        Ok(amount) => amount,
        Err(_) => {
            eprintln!("❌ Error: Failed to calculate output tokens");
            return false;
        }
    };

    let tokens_created = output_tokens - input_tokens;

    eprintln!("📊 Created: {}, Expected: {}", tokens_created, tokens_to_mint);

    if tokens_created != tokens_to_mint {
        eprintln!("❌ Error: Supply math mismatch (created={}, expected={})",
                  tokens_created, tokens_to_mint);
        return false;
    }

    eprintln!("✅ Token Mint Satisfied!");
    true
}

fn validate_scroll_release(token_app: &App, tx: &Transaction) -> bool {
    eprintln!("\n--- [ZK-DEBUG] Scroll Release Validation Start ---");

    eprintln!("[RUST-DEBUG] RAW TRANSACTION DATA:");
    eprintln!("  tx.ins count: {}", tx.ins.len());
    eprintln!("  tx.outs count: {}", tx.outs.len());
    eprintln!("  tx.coin_outs count: {}", tx.coin_outs.as_ref().map(|c: &Vec<_>| c.len()).unwrap_or(0));

    eprintln!("[RUST-DEBUG] CHECKING COIN_OUTS AMOUNTS:");
    if let Some(coin_outs) = &tx.coin_outs {
        for (i, coin) in coin_outs.iter().enumerate() {
            eprintln!("  coin_outs[{}].amount: {}", i, coin.amount);
        }
    }

    for (i, out) in tx.outs.iter().enumerate() {
        eprintln!("  tx.outs[{}] debug: {:?}", i, out);
    }

    let token_inputs: Vec<Data> = charm_values(token_app, tx.ins.iter().map(|(_, v)| v))
        .cloned()
        .collect();

    if token_inputs.is_empty() {
        eprintln!("❌ Error: No Token inputs found for Scroll release");
        return false;
    }

    eprintln!("✅ Found {} Token input(s) being spent", token_inputs.len());

    eprintln!("[RUST-DEBUG] CHECKING TOKEN INPUTS:");
    for (i, data) in token_inputs.iter().enumerate() {
        if let Ok(val) = data.value::<u64>() {
            eprintln!("  token_input[{}].value: {}", i, val);
        }
    }

    let total_input_value: u64 = token_inputs.iter()
        .filter_map(|data| data.value::<u64>().ok())
        .sum();

    eprintln!("💰 Total Token input value: {}", total_input_value);

    let token_outputs: Vec<Data> = charm_values(token_app, tx.outs.iter())
        .cloned()
        .collect();

    if token_outputs.is_empty() {
        eprintln!("✅ No Token outputs - tokens are burned for salary payment");
    } else {
        eprintln!("✅ Found {} Token output(s)", token_outputs.len());

        let total_output_value: u64 = token_outputs.iter()
            .filter_map(|data| data.value::<u64>().ok())
            .sum();

        eprintln!("💰 Total Token output value: {}", total_output_value);

        if total_output_value > 0 {
            eprintln!("❌ Error: Settlement transaction cannot create new tokens (output={})", total_output_value);
            return false;
        }
    }

    let tokens_spent = total_input_value;
    eprintln!("📊 Tokens spent in settlement: {}", tokens_spent);

    let btc_outputs = tx.coin_outs.as_ref().map_or(0, |v| v.len());

    eprintln!("💰 BTC outputs in settlement: {}", btc_outputs);

    if btc_outputs == 0 {
        eprintln!("❌ Error: Scroll release must include BTC outputs (salary, fees)");
        return false;
    }

    eprintln!("✅ Scroll release validation passed!");
    true
}

pub(crate) fn hash(data: &str) -> B32 {
    let hash = Sha256::digest(data);
    B32(hash.into())
}

#[cfg(feature = "wasm-bridge")]
#[wasm_bindgen]
pub fn process_spell_template(_template_yaml: &str, variables_json: &str) -> Result<String, JsValue> {
    let vars: BridgeVariables = serde_json::from_str(variables_json)
        .map_err(|e| JsValue::from_str(&format!("Input Parse Error: {}", e)))?;

    eprintln!("[RUST-DEBUG] process_spell_template called with type_name: {}", vars.type_name);

    let treasury_dest = hex::decode(&vars.treasury_dest)
        .map_err(|_| JsValue::from_str("Invalid treasury dest hex string"))?;

    let mut outs = Vec::new();
    let mut coins = Vec::new();
    let mut ins = Vec::new();

    if vars.type_name == "mint-nft" {
        let anchor_utxo = vars.anchor_utxo.as_ref()
            .ok_or_else(|| JsValue::from_str("anchor_utxo required for mint-nft"))?;
        let anchor_id = UtxoId::from_str(anchor_utxo)
            .map_err(|_| JsValue::from_str("Invalid anchor UTXO format"))?;

        let funding_id = UtxoId::from_str(&vars.funding_utxo)
            .map_err(|_| JsValue::from_str("Invalid funding UTXO format"))?;

        ins = vec![anchor_id, funding_id];

        let remaining = vars.remaining.as_ref()
            .ok_or_else(|| JsValue::from_str("remaining required for mint-nft"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid remaining"))?;

        let scroll_policy = vars.scroll_policy.as_ref()
            .ok_or_else(|| JsValue::from_str("scroll_policy required for mint-nft"))?
            .parse::<u8>()
            .map_err(|_| JsValue::from_str("Invalid scrollPolicy"))?;

        let pay_period_seconds = vars.pay_period_seconds.as_ref()
            .ok_or_else(|| JsValue::from_str("pay_period_seconds required for mint-nft"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid payPeriodSeconds"))?;

        let compensation_sats = vars.compensation_sats.as_ref()
            .ok_or_else(|| JsValue::from_str("compensation_sats required for mint-nft"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid compensationSats"))?;

        let ticker = vars.ticker.as_ref()
            .ok_or_else(|| JsValue::from_str("ticker required for mint-nft"))?;

        let metadata_hash = vars.metadata_hash.as_ref()
            .ok_or_else(|| JsValue::from_str("metadata_hash required for mint-nft"))?;

        outs.push(serde_json::json!({
            "0": {
                "ticker": ticker,
                "remaining": remaining,
                "metadataHash": metadata_hash,
                "scrollPolicy": scroll_policy,
                "payPeriodSeconds": pay_period_seconds,
                "compensationSats": compensation_sats
            }
        }));

        coins.push(serde_json::json!({
            "amount": 1000,
            "dest": treasury_dest
        }));

    } else if vars.type_name == "mint-token" {
        let anchor_utxo = vars.anchor_utxo.as_ref()
            .ok_or_else(|| JsValue::from_str("anchor_utxo required for mint-token"))?;
        let anchor_id = UtxoId::from_str(anchor_utxo)
            .map_err(|_| JsValue::from_str("Invalid anchor UTXO format"))?;

        let funding_id = UtxoId::from_str(&vars.funding_utxo)
            .map_err(|_| JsValue::from_str("Invalid funding UTXO format"))?;

        ins = vec![anchor_id, funding_id];

        let remaining = vars.remaining.as_ref()
            .ok_or_else(|| JsValue::from_str("remaining required for mint-token"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid remaining"))?;

        let scroll_policy = vars.scroll_policy.as_ref()
            .ok_or_else(|| JsValue::from_str("scroll_policy required for mint-token"))?
            .parse::<u8>()
            .map_err(|_| JsValue::from_str("Invalid scrollPolicy"))?;

        let pay_period_seconds = vars.pay_period_seconds.as_ref()
            .ok_or_else(|| JsValue::from_str("pay_period_seconds required for mint-token"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid payPeriodSeconds"))?;

        let compensation_sats = vars.compensation_sats.as_ref()
            .ok_or_else(|| JsValue::from_str("compensation_sats required for mint-token"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid compensationSats"))?;

        let ticker = vars.ticker.as_ref()
            .ok_or_else(|| JsValue::from_str("ticker required for mint-token"))?;

        let metadata_hash = vars.metadata_hash.as_ref()
            .ok_or_else(|| JsValue::from_str("metadata_hash required for mint-token"))?;

        if let (Some(dests_json), Some(amounts_json)) = (vars.worker_dests, vars.token_amounts) {
            let dests: Vec<String> = dests_json;
            let amounts: Vec<String> = amounts_json;

            if dests.len() != amounts.len() {
                return Err(JsValue::from_str("worker_dests and token_amounts length mismatch"));
            }

            for (i, amount_str) in amounts.iter().enumerate() {
                let amount = amount_str.parse::<u64>()
                    .map_err(|_| JsValue::from_str(&format!("Invalid token amount at index {}", i)))?;
                outs.push(serde_json::json!({ "1": amount }));

                let dest_bytes = hex::decode(&dests[i])
                    .unwrap_or_else(|_| dests[i].as_bytes().to_vec());
                coins.push(serde_json::json!({
                    "amount": 1000,
                    "dest": dest_bytes
                }));
            }
        }

        outs.push(serde_json::json!({
            "0": {
                "ticker": ticker,
                "remaining": remaining,
                "metadataHash": metadata_hash,
                "scrollPolicy": scroll_policy,
                "payPeriodSeconds": pay_period_seconds,
                "compensationSats": compensation_sats
            }
        }));

    } else if vars.type_name == "scroll-release" {
        let authority_utxos = if let Some(utxos) = &vars.authority_utxos {
            utxos.clone()
        } else if let Some(utxo) = &vars.authority_utxo {
            vec![utxo.clone()]
        } else {
            return Err(JsValue::from_str("authority_utxos or authority_utxo required for scroll-release"));
        };

        let mut ins = Vec::new();
        for utxo_str in &authority_utxos {
            let utxo_id = UtxoId::from_str(utxo_str)
                .map_err(|_| JsValue::from_str("Invalid authority UTXO format"))?;
            ins.push(utxo_id);
        }

        let funding_id = UtxoId::from_str(&vars.funding_utxo)
            .map_err(|_| JsValue::from_str("Invalid funding UTXO format"))?;
        ins.push(funding_id);

        let salary_utxo = vars.salary_utxo.as_ref()
            .ok_or_else(|| JsValue::from_str("salary_utxo required for scroll-release"))?;
        let salary_id = UtxoId::from_str(salary_utxo)
            .map_err(|_| JsValue::from_str("Invalid salary UTXO format"))?;
        ins.push(salary_id);

        eprintln!("[RUST-DEBUG] scroll-release with {} authority UTXOs", authority_utxos.len());

        let worker_dests = vars.worker_dests.unwrap_or_default();
        let token_amounts = vars.token_amounts.unwrap_or_default();

        eprintln!("[RUST-DEBUG] scroll-release branch executing with {} workers", worker_dests.len());

        if worker_dests.len() != token_amounts.len() {
            return Err(JsValue::from_str("worker_dests and token_amounts length mismatch"));
        }

        let platform_fee_address = "tb1psthmf4f2hk29er4gfx94qn4dd25y2xa0gg6tm".to_string();
        let platform_fee_bytes = hex::decode(&platform_fee_address)
            .unwrap_or_else(|_| platform_fee_address.as_bytes().to_vec());

        let scroll_fee_address = "tb1psthmf4f2hk29er4gfx94qn4dd25y2xa0gg6tm".to_string();
        let scroll_fee_bytes = hex::decode(&scroll_fee_address)
            .unwrap_or_else(|_| scroll_fee_address.as_bytes().to_vec());

        let scroll_fee_amount = 895u64;

        let mut total_salary = 0u64;

        for i in 0..authority_utxos.len() {
            outs.push(serde_json::json!({}));

            let amount = token_amounts[i].parse::<u64>()
                .map_err(|_| JsValue::from_str(&format!("Invalid salary amount at index {}", i)))?;
            total_salary += amount;

            let dest_bytes = hex::decode(&worker_dests[i])
                .unwrap_or_else(|_| worker_dests[i].as_bytes().to_vec());
            coins.push(serde_json::json!({
                "amount": amount,
                "dest": dest_bytes
            }));
        }

        let platform_fee = total_salary / 100;
        outs.push(serde_json::json!({}));
        if platform_fee > 0 {
            coins.push(serde_json::json!({
                "amount": platform_fee,
                "dest": platform_fee_bytes
            }));
        }

        outs.push(serde_json::json!({}));
        coins.push(serde_json::json!({
            "amount": scroll_fee_amount,
            "dest": scroll_fee_bytes
        }));

        let remaining = vars.remaining.as_ref()
            .ok_or_else(|| JsValue::from_str("remaining required for scroll-release"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid remaining"))?;

        let scroll_policy = vars.scroll_policy.as_ref()
            .ok_or_else(|| JsValue::from_str("scroll_policy required for scroll-release"))?
            .parse::<u8>()
            .map_err(|_| JsValue::from_str("Invalid scrollPolicy"))?;

        let pay_period_seconds = vars.pay_period_seconds.as_ref()
            .ok_or_else(|| JsValue::from_str("pay_period_seconds required for scroll-release"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid payPeriodSeconds"))?;

        let compensation_sats = vars.compensation_sats.as_ref()
            .ok_or_else(|| JsValue::from_str("compensation_sats required for scroll-release"))?
            .parse::<u64>()
            .map_err(|_| JsValue::from_str("Invalid compensationSats"))?;

        let ticker = vars.ticker.as_ref()
            .ok_or_else(|| JsValue::from_str("ticker required for scroll-release"))?;

        let metadata_hash = vars.metadata_hash.as_ref()
            .ok_or_else(|| JsValue::from_str("metadata_hash required for scroll-release"))?;

        outs.push(serde_json::json!({
            "0": {
                "ticker": ticker,
                "remaining": remaining,
                "metadataHash": metadata_hash,
                "scrollPolicy": scroll_policy,
                "payPeriodSeconds": pay_period_seconds,
                "compensationSats": compensation_sats
            }
        }));

        let nft_dest = hex::decode(&vars.treasury_dest)
            .map_err(|_| JsValue::from_str("Invalid NFT destination"))?;
        coins.push(serde_json::json!({
            "amount": 1000,
            "dest": nft_dest
        }));

        let has_treasury_change = vars.has_treasury_change.unwrap_or(false);
        if has_treasury_change {
            outs.push(serde_json::json!({}));
            let change_dest = hex::decode(&vars.treasury_dest)
                .map_err(|_| JsValue::from_str("Invalid change destination"))?;
            coins.push(serde_json::json!({
                "amount": 0,
                "dest": change_dest
            }));
        }
    }

    let spell = serde_json::json!({
        "version": 11,
        "tx": {
            "ins": ins,
            "outs": outs,
            "coins": coins
        },
        "app_public_inputs": {
            format!("n/{}/{}", vars.app_id, vars.app_vk): serde_json::Value::Null,
            format!("t/{}/{}", vars.app_id, vars.app_vk): serde_json::Value::Null
        }
    });

    serde_json::to_string(&spell)
        .map_err(|e| JsValue::from_str(&format!("Serialization Error: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use charms_sdk::data::UtxoId;

    #[test]
    fn test_hash() {
        let utxo_id =
            UtxoId::from_str("dc78b09d767c8565c4a58a95e7ad5ee22b28fc1685535056a395dc94929cdd5f:1")
                .unwrap();
        let data = utxo_id.to_string();
        let expected = "f54f6d40bd4ba808b188963ae5d72769ad5212dd1d29517ecc4063dd9f033faa";
        assert_eq!(&hash(&data).to_string(), expected);
    }

    #[test]
    fn test_nft_content_validation() {
        let test_hash = "f54f6d40bd4ba808b188963ae5d72769ad5212dd1d29517ecc4063dd9f033faa";

        let valid = NftContent {
            ticker: "CHARMS-PAY".to_string(),
            remaining: 1,
            metadata_hash: test_hash.to_string(),
            scroll_policy: 0,
            pay_period_seconds: 1209600,
            compensation_sats: 5000000,
        };
        assert!(valid.validate());
        assert!(valid.is_time_based());
        assert!(!valid.is_proof_based());

        let valid_proof = NftContent {
            scroll_policy: 1,
            ..valid.clone()
        };
        assert!(valid_proof.validate());
        assert!(!valid_proof.is_time_based());
        assert!(valid_proof.is_proof_based());

        let invalid_ticker = NftContent {
            ticker: "".to_string(),
            ..valid.clone()
        };
        assert!(!invalid_ticker.validate());

        let invalid_hash = NftContent {
            metadata_hash: "".to_string(),
            ..valid.clone()
        };
        assert!(!invalid_hash.validate());

        let invalid_period = NftContent {
            pay_period_seconds: 0,
            ..valid.clone()
        };
        assert!(!invalid_period.validate());

        let invalid_policy = NftContent {
            scroll_policy: 2,
            ..valid.clone()
        };
        assert!(!invalid_policy.validate());

        let invalid_compensation = NftContent {
            compensation_sats: 500,
            ..valid
        };
        assert!(!invalid_compensation.validate());
    }

    #[test]
    fn test_nft_content_serialization() {
        let test_hash = "f54f6d40bd4ba808b188963ae5d72769ad5212dd1d29517ecc4063dd9f033faa";

        let content = NftContent {
            ticker: "CHARMS-PAY".to_string(),
            remaining: 1,
            metadata_hash: test_hash.to_string(),
            scroll_policy: 1,
            pay_period_seconds: 604800,
            compensation_sats: 2500000,
        };

        let serialized = serde_json::to_string(&content).unwrap();
        let deserialized: NftContent = serde_json::from_str(&serialized).unwrap();
        assert_eq!(content, deserialized);

        assert!(serialized.contains("\"metadataHash\""));
        assert!(serialized.contains("\"scrollPolicy\""));
        assert!(serialized.contains("\"payPeriodSeconds\""));
        assert!(serialized.contains("\"compensationSats\""));
        assert!(!serialized.contains("\"metadata_hash\""));
        assert!(!serialized.contains("\"scroll_policy\""));
        assert!(!serialized.contains("\"pay_period_seconds\""));
        assert!(!serialized.contains("\"compensation_sats\""));
        assert!(serialized.contains("\"scrollPolicy\":1"));
    }

    #[cfg(feature = "wasm-bridge")]
    #[test]
    fn test_bridge_variables_deserialization() {
        let json = r#"{
            "type_name": "mint-nft",
            "anchor_utxo": "abc123:0",
            "funding_utxo": "def456:1",
            "ticker": "TEST-PAY",
            "remaining": "100",
            "metadata_hash": "hash123",
            "scroll_policy": "0",
            "pay_period_seconds": "1209600",
            "compensation_sats": "5000000",
            "treasury_dest": "5120abc",
            "app_id": "app123",
            "app_vk": "vk456"
        }"#;

        let vars: BridgeVariables = serde_json::from_str(json).unwrap();
        assert_eq!(vars.type_name, "mint-nft");
        assert_eq!(vars.anchor_utxo, Some("abc123:0".to_string()));
        assert_eq!(vars.ticker, Some("TEST-PAY".to_string()));
    }

    #[cfg(feature = "wasm-bridge")]
    #[test]
    fn test_scroll_release_variables() {
        let json = r#"{
            "type_name": "scroll-release",
            "authority_utxo": "abc123:0",
            "funding_utxo": "def456:1",
            "salary_utxo": "ghi789:2",
            "treasury_dest": "5120abc",
            "app_id": "app123",
            "app_vk": "vk456",
            "worker_dests": ["tb1addr1", "tb1addr2"],
            "token_amounts": ["1000", "2000"]
        }"#;

        let vars: BridgeVariables = serde_json::from_str(json).unwrap();
        assert_eq!(vars.type_name, "scroll-release");
        assert_eq!(vars.authority_utxo, Some("abc123:0".to_string()));
        assert_eq!(vars.salary_utxo, Some("ghi789:2".to_string()));
        assert_eq!(vars.worker_dests, Some(vec!["tb1addr1".to_string(), "tb1addr2".to_string()]));
        assert_eq!(vars.token_amounts, Some(vec!["1000".to_string(), "2000".to_string()]));
    }
}