//! Small, stateless boundary around the pinned portable signer. The caller commits
//! snapshot + session atomically BEFORE exposing signatures or making network calls.
#![forbid(unsafe_code)]
use ckb_types::{packed, prelude::*};
use fiber_lsp_sdk::{
    ChainVerifier, FundingVerifier, HostedSession, HostedSessionState, MemoryStore, OpeningNetwork,
    OpeningPersistence, ProcessOutcome, RootKey, RootSigner, SessionError, SignerError,
    SigningPolicy, SubmitParams, TenantOpeningRpc, VerifiedCell,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}
fn decode<T: DeserializeOwned>(v: Value) -> Result<T, JsValue> {
    serde_json::from_value(v).map_err(err)
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, JsValue> {
    v[k].as_str()
        .ok_or_else(|| err(format!("missing string: {k}")))
}
fn uint(v: &Value, k: &str) -> Result<u128, JsValue> {
    let s = text(v, k)?;
    u128::from_str_radix(
        s.strip_prefix("0x")
            .ok_or_else(|| err("expected hex integer"))?,
        16,
    )
    .map_err(err)
}
fn u64v(v: &Value, k: &str) -> Result<u64, JsValue> {
    u64::try_from(uint(v, k)?).map_err(err)
}
fn secret(bytes: &[u8]) -> Result<RootKey, JsValue> {
    RootKey::import(
        bytes
            .try_into()
            .map_err(|_| err("root key must be 32 bytes"))?,
    )
    .map_err(err)
}
fn envelope(
    store: &MemoryStore,
    session: &HostedSession<MemoryStore>,
    value: Value,
) -> Result<String, JsValue> {
    Ok(
        json!({"snapshot":hex::encode(store.snapshot().map_err(err)?),
        "session":serde_json::to_string(session.state()).map_err(err)?, "value":value})
        .to_string(),
    )
}
#[wasm_bindgen]
pub async fn create_identity() -> Result<String, JsValue> {
    let store = MemoryStore::default();
    let created = RootSigner::create_random(store.clone())
        .await
        .map_err(err)?;
    let backup = Zeroizing::new(created.root_key_backup.expose_secret());
    let session = HostedSession::new(created.root_signer);
    envelope(
        &store,
        &session,
        json!({"root":hex::encode(*backup),
        "tenantId":session.tenant_id().as_str(), "publicKey":session.identity_public_key().to_string()}),
    )
}
#[wasm_bindgen]
pub fn parse_invoice(invoice: &str) -> Result<String, JsValue> {
    let inv: fiber_types::CkbInvoice = invoice.parse().map_err(err)?;
    let expiry = inv.expiry_time().map(|v| v.as_secs()).unwrap_or(0);
    let timestamp = inv.data.timestamp;
    let expires = if inv.expiry_time().is_some() {
        timestamp
            .checked_add(u128::from(expiry) * 1000)
            .ok_or_else(|| err("invoice expiry overflow"))?
    } else {
        9_007_199_254_740_991
    };
    let payee = inv.recover_payee_pub_key().map_err(err)?;
    let script: Option<ckb_jsonrpc_types::Script> = inv.udt_type_script().cloned().map(Into::into);
    Ok(json!({"paymentHash":inv.payment_hash(), "amount":inv.amount().map(|v|format!("0x{v:x}")),
        "currency":inv.currency, "payeePublicKey":payee.to_string(), "timestamp":format!("0x{timestamp:x}"),
        "expiresAt":format!("0x{expires:x}"), "expirySeconds":format!("0x{expiry:x}"),
        "hashAlgorithm":inv.hash_algorithm().copied().unwrap_or_default(), "udtTypeScript":script,
        "finalTlcExpiryDelta":format!("0x{:x}", inv.final_tlc_minimum_expiry_delta_or_default()),
        "allowMpp":inv.allow_mpp(), "trampolineHint":inv.trampoline_route_hint().map(|p|p.to_string()),
        "description":inv.description(), "signed":inv.is_signed()}).to_string())
}
#[wasm_bindgen]
pub fn payment_hash(preimage: &[u8], algorithm: &str) -> Result<String, JsValue> {
    if preimage.len() != 32 {
        return Err(err("preimage must be 32 bytes"));
    }
    let algo: fiber_types::HashAlgorithm = decode(json!(algorithm))?;
    Ok(format!("0x{}", hex::encode(algo.hash(preimage))))
}
#[wasm_bindgen]
pub fn transaction_hash(transaction: &str) -> Result<String, JsValue> {
    let tx: ckb_jsonrpc_types::Transaction = serde_json::from_str(transaction).map_err(err)?;
    let tx: packed::Transaction = tx.into();
    Ok(format!("0x{}", hex::encode(tx.calc_tx_hash().as_slice())))
}
#[wasm_bindgen]
pub fn pack_script(script: &str) -> Result<String, JsValue> {
    let script: ckb_jsonrpc_types::Script = serde_json::from_str(script).map_err(err)?;
    let script: packed::Script = script.into();
    Ok(format!("0x{}", hex::encode(script.as_slice())))
}

struct Opening {
    result: Option<fiber_json_types::OpenChannelWithExternalFundingResult>,
    inputs: Vec<packed::OutPoint>,
}
#[async_trait::async_trait(?Send)]
impl TenantOpeningRpc for Opening {
    async fn open_channel_with_external_funding(
        &self,
        _: &str,
        _: fiber_json_types::OpenChannelWithExternalFundingParams,
    ) -> Result<fiber_json_types::OpenChannelWithExternalFundingResult, SessionError> {
        self.result
            .clone()
            .ok_or_else(|| SessionError::Invalid("intent saved".into()))
    }
}
#[async_trait::async_trait(?Send)]
impl FundingVerifier for Opening {
    async fn verify_funding(
        &self,
        _: &fiber_json_types::OpenChannelWithExternalFundingParams,
        _: &fiber_json_types::OpenChannelWithExternalFundingResult,
    ) -> Result<Vec<packed::OutPoint>, SessionError> {
        Ok(self.inputs.clone())
    }
}
#[async_trait::async_trait(?Send)]
impl OpeningPersistence for Opening {
    async fn save_session(&self, _: &HostedSessionState) -> Result<(), SessionError> {
        Ok(())
    }
}
// A pre-resolved cell supplied by the trusted chain adapter. All transaction and
// recovery checks still run in Rust. This adapter cannot authorize on-chain spends.
struct FundingCell {
    point: packed::OutPoint,
    cell: VerifiedCell,
}
#[async_trait::async_trait(?Send)]
impl ChainVerifier for FundingCell {
    async fn live_cell(&self, point: &packed::OutPoint) -> Result<VerifiedCell, SignerError> {
        if point != &self.point {
            return Err(SignerError::InvalidContent(
                "unexpected funding point".into(),
            ));
        }
        Ok(self.cell.clone())
    }
    async fn verify_commitment_lineage(
        &self,
        _: fiber_types::Hash256,
        _: &packed::OutPoint,
    ) -> Result<(), SignerError> {
        Err(SignerError::InvalidContent(
            "on-chain spending is unsupported".into(),
        ))
    }
    async fn verify_maturity(&self, _: &[packed::CellInput]) -> Result<(), SignerError> {
        Err(SignerError::InvalidContent(
            "on-chain spending is unsupported".into(),
        ))
    }
    async fn median_time_ms(&self) -> Result<u64, SignerError> {
        Err(SignerError::InvalidContent(
            "on-chain spending is unsupported".into(),
        ))
    }
}

#[wasm_bindgen]
pub async fn execute(
    root: Vec<u8>,
    snapshot: &str,
    state: &str,
    command: &str,
) -> Result<String, JsValue> {
    let root = Zeroizing::new(root);
    let bytes = hex::decode(snapshot).map_err(err)?;
    let store = MemoryStore::from_snapshot(&bytes).map_err(err)?;
    let signer = RootSigner::open(secret(&root)?, store.clone())
        .await
        .map_err(err)?;
    let mut session =
        HostedSession::new(signer).with_state(serde_json::from_str(state).map_err(err)?);
    let c: Value = serde_json::from_str(command).map_err(err)?;
    let value = match text(&c, "action")? {
        "identity" => {
            json!({"tenantId":session.tenant_id().as_str(), "publicKey":session.identity_public_key().to_string()})
        }
        "beginRegistration" => serde_json::to_value(
            session
                .begin_registration(
                    decode(c["nodePublicKey"].clone())?,
                    decode(c["requestId"].clone())?,
                    u64v(&c, "now")?,
                )
                .map_err(err)?,
        )
        .map_err(err)?,
        "finishRegistration" => {
            session
                .finish_registration(decode(c["result"].clone())?)
                .map_err(err)?;
            Value::Null
        }
        "discardPending" => {
            let mut state = session.state().clone();
            state.pending = None;
            state.opening_request = None;
            session = session.with_state(state);
            Value::Null
        }
        "allocateChannel" => serde_json::to_value(fiber_lsp_sdk::json::open_material_to_rpc(
            &session.allocate_pending_channel().await.map_err(err)?,
        ))
        .map_err(err)?,
        "beginOpening" | "finishOpening" => {
            let begin = c["action"] == "beginOpening";
            let adapter = Opening {
                result: if begin {
                    None
                } else {
                    Some(decode(c["result"].clone())?)
                },
                inputs: if begin {
                    vec![]
                } else {
                    decode::<Vec<ckb_jsonrpc_types::OutPoint>>(c["inputs"].clone())?
                        .into_iter()
                        .map(Into::into)
                        .collect()
                },
            };
            let network: OpeningNetwork = decode(c["network"].clone())?;
            match session
                .open_tenant_channel(
                    decode(c["request"].clone())?,
                    &network,
                    &adapter,
                    &adapter,
                    &adapter,
                )
                .await
            {
                Err(SessionError::Invalid(s)) if begin && s == "intent saved" => Value::Null,
                result => serde_json::to_value(result.map_err(err)?).map_err(err)?,
            }
        }
        "sign" => {
            if c["manual"] == true {
                session = session.with_policy(SigningPolicy::Manual);
            }
            let outcome = session
                .handle_channel_status(
                    decode(c["channelId"].clone())?,
                    decode(c["status"].clone())?,
                    u64v(&c, "now")?,
                )
                .await
                .map_err(err)?;
            let submit = match outcome {
                ProcessOutcome::Idle => return envelope(&store, &session, json!({"type":"idle"})),
                ProcessOutcome::Denied => return Err(err("signing denied")),
                ProcessOutcome::ReadyToSubmit(p) => p,
                ProcessOutcome::NeedConfirmation(p) => {
                    if c["confirm"] != true {
                        let review = p.prepared.review();
                        let commitment = p.prepared.commitment_review().map(|r| json!({
                            "forRemote":r.for_remote,"version":format!("0x{:x}",r.version),
                            "previousLocalAmount":format!("0x{:x}",r.previous_local_amount),
                            "localAmount":format!("0x{:x}",r.local_amount),"remoteAmount":format!("0x{:x}",r.remote_amount),
                            "hasOutboundChanges":r.has_outbound_changes}));
                        return envelope(
                            &store,
                            &session,
                            json!({"type":"confirmation", "review":{
                            "intent":format!("{:?}",review.intent), "contentHash":hex::encode(review.content_hash),
                            "signingMessage":hex::encode(review.signing_message),"canonicalContent":hex::encode(&review.canonical_content),
                            "warnings":format!("{:?}",review.warnings),"commitment":commitment}}),
                        );
                    }
                    session.confirm(p, u64v(&c, "now")?).await.map_err(err)?
                }
            };
            match submit {
                SubmitParams::Channel(p) => json!({"type":"submit", "params":p}),
                _ => return Err(err("unexpected watchtower request")),
            }
        }
        "authorizePayment" | "authorizeInvoice" => {
            let a = &c["authorization"];
            let terms = fiber_lsp_sdk::PaymentAuthorization {
                payment_hash: decode(a["payment_hash"].clone())?,
                hash_algorithm: decode(a["hash_algorithm"].clone())?,
                inbound: a["inbound"]
                    .as_bool()
                    .ok_or_else(|| err("missing direction"))?,
                amount: uint(a, "amount")?,
                expires_at_ms: u64v(a, "expires_at_ms")?,
                min_tlc_expiry_delta_ms: u64v(a, "min_tlc_expiry_delta_ms")?,
                max_tlc_expiry_ms: u64v(a, "max_tlc_expiry_ms")?,
            };
            let signer = session
                .channel_signer(decode(c["channelId"].clone())?)
                .await
                .map_err(err)?;
            if c["action"] == "authorizeInvoice" {
                signer
                    .authorize_invoice(terms, decode(c["preimage"].clone())?)
                    .await
                    .map_err(err)?;
            } else {
                signer.authorize_payment(terms).await.map_err(err)?;
            }
            Value::Null
        }
        "fulfill" | "cancel" | "release" | "close" | "records" => {
            let signer = session
                .channel_signer(decode(c["channelId"].clone())?)
                .await
                .map_err(err)?;
            match text(&c, "action")? {
                "fulfill" => {
                    signer
                        .authorize_fulfillment(
                            decode(c["paymentHash"].clone())?,
                            decode(c["preimage"].clone())?,
                        )
                        .await
                        .map_err(err)?;
                    Value::Null
                }
                "cancel" => {
                    signer
                        .authorize_cancellation(decode(c["paymentHash"].clone())?)
                        .await
                        .map_err(err)?;
                    Value::Null
                }
                "close" => {
                    signer
                        .authorize_close(fiber_lsp_sdk::CloseAuthorization {
                            fee: u64v(&c, "fee")?,
                            local_fee_share: u64v(&c, "fee")?,
                            remote_fee_share: 0,
                        })
                        .await
                        .map_err(err)?;
                    Value::Null
                }
                "release" => {
                    let point: ckb_jsonrpc_types::OutPoint = decode(c["outPoint"].clone())?;
                    let output: ckb_jsonrpc_types::CellOutput =
                        decode(c["cell"]["output"].clone())?;
                    let chain = FundingCell {
                        point: point.into(),
                        cell: VerifiedCell {
                            output: output.into(),
                            data: hex::decode(text(&c["cell"], "data")?.trim_start_matches("0x"))
                                .map_err(err)?,
                        },
                    };
                    serde_json::to_value(
                        signer
                            .authorize_preimage_release(
                                decode(c["paymentHash"].clone())?,
                                decode(c["preimage"].clone())?,
                                u64v(&c, "now")?,
                                &chain,
                            )
                            .await
                            .map_err(err)?,
                    )
                    .map_err(err)?
                }
                _ => {
                    let records = signer.recovery_records().await.map_err(err)?;
                    json!(records.iter().map(|r|json!({"forRemote":r.reference.for_remote,
                        "version":format!("0x{:x}",r.reference.version),"txHash":r.reference.tx_hash,
                        "complete":r.complete_signature.is_some(),"localAmount":format!("0x{:x}",r.settlement.data.local_amount),
                        "remoteAmount":format!("0x{:x}",r.settlement.data.remote_amount),
                        "tlcs":r.settlement.data.tlcs.iter().map(|t|json!({"paymentHash":t.payment_hash,
                            "amount":format!("0x{:x}",t.payment_amount)})).collect::<Vec<_>>() })).collect::<Vec<_>>())
                }
            }
        }
        _ => return Err(err("unknown signer command")),
    };
    envelope(&store, &session, value)
}

/// Construct exact cooperative-close outputs and fee from trusted terms. The
/// remote proposal and committed transaction must match this template.
#[wasm_bindgen]
pub fn close_template(args: &str) -> Result<String, JsValue> {
    let v: Value = serde_json::from_str(args).map_err(err)?;
    let funding: ckb_jsonrpc_types::Transaction = decode(v["funding"].clone())?;
    let funding: packed::Transaction = funding.into();
    let local: ckb_jsonrpc_types::Script = decode(v["localScript"].clone())?;
    let remote: ckb_jsonrpc_types::Script = decode(v["remoteScript"].clone())?;
    let asset: Option<ckb_jsonrpc_types::Script> = decode(v["asset"].clone())?;
    let asset: Option<packed::Script> = asset.map(Into::into);
    let deps: Vec<ckb_jsonrpc_types::CellDep> = decode(v["deps"].clone())?;
    let local_amount = uint(&v, "localAmount")?;
    let remote_amount = uint(&v, "remoteAmount")?;
    let (local_capacity, remote_capacity) = if asset.is_some() {
        (u64v(&v, "localReserve")?, u64v(&v, "remoteReserve")?)
    } else {
        (
            u64::try_from(local_amount).map_err(err)?,
            u64::try_from(remote_amount).map_err(err)?,
        )
    };
    let local_output = packed::CellOutput::new_builder()
        .capacity(local_capacity)
        .lock(local)
        .type_(asset.clone().pack())
        .build();
    let remote_output = packed::CellOutput::new_builder()
        .capacity(remote_capacity)
        .lock(remote)
        .type_(asset.clone().pack())
        .build();
    let data = if asset.is_some() {
        vec![
            local_amount.to_le_bytes().to_vec().pack(),
            remote_amount.to_le_bytes().to_vec().pack(),
        ]
    } else {
        vec![packed::Bytes::default(); 2]
    };
    let tx = ckb_types::core::TransactionBuilder::default()
        .cell_deps(
            deps.into_iter()
                .map(Into::into)
                .collect::<Vec<packed::CellDep>>(),
        )
        .input(
            packed::CellInput::new_builder()
                .previous_output(packed::OutPoint::new(funding.calc_tx_hash(), 0))
                .build(),
        )
        .output(local_output.clone())
        .output(remote_output)
        .outputs_data(data)
        .witness([0u8; 112].pack())
        .build();
    let fee = u64::try_from(
        uint(&v, "feeRate")?
            .checked_mul(tx.data().serialized_size_in_block() as u128)
            .ok_or_else(|| err("fee overflow"))?
            / 1000,
    )
    .map_err(err)?;
    let local_output = local_output
        .as_builder()
        .capacity(
            local_capacity
                .checked_sub(fee)
                .ok_or_else(|| err("close fee exceeds local capacity"))?,
        )
        .build();
    let occupied = local_output
        .occupied_capacity(
            ckb_types::core::Capacity::bytes(if asset.is_some() { 16 } else { 0 }).map_err(err)?,
        )
        .map_err(err)?
        .as_u64();
    let capacity: u64 = local_output.capacity().unpack();
    if capacity < occupied {
        return Err(err("local close output is below occupied capacity"));
    }
    let outputs = vec![local_output, tx.outputs().get(1).unwrap()];
    let tx = tx.as_advanced_builder().set_outputs(outputs).build();
    let tx: ckb_jsonrpc_types::Transaction = tx.data().into();
    Ok(json!({"fee":format!("0x{fee:x}"),"transaction":tx}).to_string())
}

#[wasm_bindgen]
pub fn verify_invoice_response(address: &str, body: &str) -> Result<(), JsValue> {
    let parsed: fiber_types::CkbInvoice = address.parse().map_err(err)?;
    let expected = fiber_json_types::CkbInvoice::from(parsed);
    let actual: fiber_json_types::CkbInvoice = serde_json::from_str(body).map_err(err)?;
    if expected != actual {
        return Err(err("invoice object differs from encoded invoice"));
    }
    Ok(())
}

#[wasm_bindgen]
pub fn validate_public_key(value: &str) -> Result<(), JsValue> {
    let bytes = hex::decode(value).map_err(err)?;
    fiber_types::Pubkey::from_slice(&bytes).map_err(err)?;
    Ok(())
}
