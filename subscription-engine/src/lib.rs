use charms_sdk::data::{
    charm_values, sum_token_amount, App, Data, Transaction, UtxoId, B32, NFT, TOKEN,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;

// --------------------------------------------------------------------------------
// NFT Content Structure for Payroll
// --------------------------------------------------------------------------------
// This struct defines what lives ON-CHAIN in the Plan NFT.
// Only fields that affect ENFORCEMENT logic go here.
// Human-readable data (name, role, salary) goes in encrypted IPFS.
//
// #[serde(rename_all = "camelCase")] ensures JSON uses camelCase
// for compatibility with WASM module and frontend dashboard
//
// FIX #1: Using u8 for scroll_policy instead of enum to ensure CBOR parsing succeeds
// FIX #2: Using String for metadata_hash to match TypeScript hex string format
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NftContent {
    pub ticker: String,              // "CHARMS-PAY"
    pub remaining: u64,               // Supply remaining (usually 1 per period)
    pub metadata_hash: String,         // SHA256 of encrypted IPFS JSON as hex string
    pub scroll_policy: u8,             // 0=time, 1=proof (using u8 for CBOR compatibility)
    pub pay_period_seconds: u64,       // e.g., 1209600 for 2 weeks
    pub compensation_sats: u64,         // Per period in satoshis
}

impl NftContent {
    pub fn validate(&self) -> bool {
        // Basic validation rules enforced on-chain
        if self.ticker.is_empty() {
            return false;
        }
        
        // metadata_hash must be non-empty (64-char hex validation happens off-chain)
        if self.metadata_hash.is_empty() {
            return false;
        }
        
        if self.pay_period_seconds == 0 {
            return false;
        }
        
        // Validate scroll_policy range (must be 0 or 1)
        if self.scroll_policy > 1 {
            return false;
        }
        
        if self.compensation_sats < 1000 { // Below dust limit
            return false;
        }
        
        true
    }
    
    // Helper method to interpret scroll_policy semantically
    pub fn is_time_based(&self) -> bool {
        self.scroll_policy == 0
    }
    
    pub fn is_proof_based(&self) -> bool {
        self.scroll_policy == 1
    }
}

// --------------------------------------------------------------------------------
// Main App Contract Entry Point
// --------------------------------------------------------------------------------
pub fn app_contract(app: &App, tx: &Transaction, _x: &Data, w: &Data) -> bool {
    // Force compiler to recognize the argument exists (prevents optimization trap)
    let _ = _x.bytes();
    
    match app.tag {
        NFT => nft_contract_satisfied(app, tx, w),
        TOKEN => token_contract_satisfied(app, tx),
        _ => false,
    }
}

// --------------------------------------------------------------------------------
// NFT Contract Logic
// --------------------------------------------------------------------------------
fn nft_contract_satisfied(app: &App, tx: &Transaction, w: &Data) -> bool {
    // ----------------------------------------------------------------------------
    // Step 1: Safely extract witness data - NO UNWRAP()
    // ----------------------------------------------------------------------------
    let w_str = match w.value::<String>() {
        Ok(val) => val,
        Err(_) => return false,
    };
    
    // ----------------------------------------------------------------------------
    // Step 2: Verify hash(w) == app.identity (establishes authority)
    // ----------------------------------------------------------------------------
    if hash(&w_str) != app.identity {
        return false;
    }
    
    // ----------------------------------------------------------------------------
    // Step 3: Parse UTXO ID from witness
    // ----------------------------------------------------------------------------
    let w_utxo_id = match UtxoId::from_str(&w_str) {
        Ok(id) => id,
        Err(_) => return false,
    };
    
    // ----------------------------------------------------------------------------
    // Step 4: Determine transaction type
    // ----------------------------------------------------------------------------
    let is_nft_minting = tx.ins.iter().any(|(utxo_id, _)| utxo_id == &w_utxo_id);
    
    if is_nft_minting {
        // NFT MINTING: Original UTXO must be in inputs
        if !tx.ins.iter().any(|(utxo_id, _)| utxo_id == &w_utxo_id) {
            return false;
        }
    }
    
    // ----------------------------------------------------------------------------
    // Step 5: Validate NFT outputs
    // ----------------------------------------------------------------------------
    let nft_outputs: Vec<&Data> = charm_values(app, tx.outs.iter()).collect();
    
    if nft_outputs.is_empty() {
        return false;
    }
    
    // For NFT minting, expect exactly 1 NFT output
    if is_nft_minting && nft_outputs.len() != 1 {
        return false;
    }
    
    // ----------------------------------------------------------------------------
    // Step 6: Validate each NFT content structure - SAFE PARSING
    // ----------------------------------------------------------------------------
    for (i, data) in nft_outputs.iter().enumerate() {
        let content: NftContent = match data.value() {
            Ok(c) => c,
            Err(_) => return false,
        };
        
        // Validate content
        if !content.validate() {
            return false;
        }
        
        // Additional cross-check for NFT minting
        if is_nft_minting && i == 0 {
            // For the primary NFT being minted, verify it has a non-empty ticker
            if content.ticker.is_empty() {
                return false;
            }
        }
    }
    
    true
}

// --------------------------------------------------------------------------------
// Token Contract Logic
// --------------------------------------------------------------------------------
fn token_contract_satisfied(token_app: &App, tx: &Transaction) -> bool {
    can_mint_token(token_app, tx)
}

// --------------------------------------------------------------------------------
// Token Minting Validation - UPDATED WITH DEBUG LOGGING
// --------------------------------------------------------------------------------
fn can_mint_token(token_app: &App, tx: &Transaction) -> bool {
    eprintln!("\n--- [ZK-DEBUG] Token Mint Start ---");
    
    // Create corresponding NFT app (same identity, different tag)
    let nft_app = App {
        tag: NFT,
        identity: token_app.identity.clone(),
        vk: token_app.vk.clone(),
    };

    // ----------------------------------------------------------------------------
    // Step 1: Find NFT content in inputs - SAFE PARSING with debug logging
    // ----------------------------------------------------------------------------
    let nft_inputs: Vec<NftContent> = charm_values(&nft_app, tx.ins.iter().map(|(_, v)| v))
        .filter_map(|data| {
            match data.value::<NftContent>() {
                Ok(content) => Some(content),
                Err(_) => None,
            }
        })
        .collect();

    if nft_inputs.is_empty() {
        eprintln!("❌ Error: No NFT found in inputs for ID: {}", nft_app.identity);
        return false; 
    }
    
    let nft_in = &nft_inputs[0];
    let incoming_supply = nft_in.remaining;
    eprintln!("✅ Incoming Supply: {}", incoming_supply);

    // ----------------------------------------------------------------------------
    // Step 2: Find NFT content in outputs - SAFE PARSING with debug logging
    // ----------------------------------------------------------------------------
    let nft_outputs: Vec<NftContent> = charm_values(&nft_app, tx.outs.iter())
        .filter_map(|data| {
            match data.value::<NftContent>() {
                Ok(content) => Some(content),
                Err(_) => None,
            }
        })
        .collect();

    if nft_outputs.is_empty() {
        eprintln!("❌ Error: No NFT found in outputs");
        return false;
    }
    
    let nft_out = &nft_outputs[0];
    let outgoing_supply = nft_out.remaining;
    eprintln!("✅ Outgoing Supply: {}", outgoing_supply);

    // ----------------------------------------------------------------------------
    // Step 3: Validate supply constraints with debug logging
    // ----------------------------------------------------------------------------
    if incoming_supply < outgoing_supply {
        eprintln!("❌ Error: Supply increased ({} < {})", incoming_supply, outgoing_supply);
        return false;
    }
    
    let tokens_to_mint = incoming_supply - outgoing_supply;

    // ----------------------------------------------------------------------------
    // Step 4: Validate token amounts - SAFE WITH unwrap_or and debug logging
    // ----------------------------------------------------------------------------
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

// --------------------------------------------------------------------------------
// Hash Function (SHA256)
// --------------------------------------------------------------------------------
pub(crate) fn hash(data: &str) -> B32 {
    let hash = Sha256::digest(data);
    B32(hash.into())
}

// --------------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------------
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
        // Create a test hash string (64 hex chars)
        let test_hash = "f54f6d40bd4ba808b188963ae5d72769ad5212dd1d29517ecc4063dd9f033faa";
        
        let valid = NftContent {
            ticker: "CHARMS-PAY".to_string(),
            remaining: 1,
            metadata_hash: test_hash.to_string(),
            scroll_policy: 0, // Time-based
            pay_period_seconds: 1209600,
            compensation_sats: 5000000,
        };
        assert!(valid.validate());
        assert!(valid.is_time_based());
        assert!(!valid.is_proof_based());

        let valid_proof = NftContent {
            scroll_policy: 1, // Proof-based
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
            scroll_policy: 2, // Invalid (must be 0 or 1)
            ..valid.clone()
        };
        assert!(!invalid_policy.validate());

        let invalid_compensation = NftContent {
            compensation_sats: 500, // Below dust
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
            scroll_policy: 1, // Proof-based
            pay_period_seconds: 604800,
            compensation_sats: 2500000,
        };

        let serialized = serde_json::to_string(&content).unwrap();
        
        let deserialized: NftContent = serde_json::from_str(&serialized).unwrap();
        assert_eq!(content, deserialized);
        
        // Verify field names are camelCase (for WASM/frontend compatibility)
        assert!(serialized.contains("\"metadataHash\""));
        assert!(serialized.contains("\"scrollPolicy\""));
        assert!(serialized.contains("\"payPeriodSeconds\""));
        assert!(serialized.contains("\"compensationSats\""));
        
        // Verify snake_case is NOT present
        assert!(!serialized.contains("\"metadata_hash\""));
        assert!(!serialized.contains("\"scroll_policy\""));
        assert!(!serialized.contains("\"pay_period_seconds\""));
        assert!(!serialized.contains("\"compensation_sats\""));
        
        // Verify scroll_policy is serialized as number, not string
        assert!(serialized.contains("\"scrollPolicy\":1"));
        // Verify metadataHash is serialized as string
        assert!(serialized.contains("\"metadataHash\":\"f54f6d40bd4ba808b188963ae5d72769ad5212dd1d29517ecc4063dd9f033faa\""));
    }
}