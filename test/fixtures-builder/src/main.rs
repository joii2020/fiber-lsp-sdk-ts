//! Derived from the Fiber SDK opening and commitment fixtures (MIT).
//! Copyright (c) 2024-2026 Nervos Foundation.
//! Deterministic test terms; root/channel randomness is recorded in the fixture.
//! All private keys in this program and its output are public test keys.
use ckb_types::{
    core::TransactionBuilder,
    packed::{CellInput, CellOutput, OutPoint, Script},
    prelude::*,
};
use fiber_lsp_sdk::*;
use fiber_types::{
    blake2b_hash_with_salt, settlement_witness_hash, CommitmentContractFeatures, InMemorySigner,
    SettlementData,
};
use musig2::{AggNonce, KeyAggContext};
use serde_json::json;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let store = MemoryStore::default();
    let root = RootSigner::create(RootKey::import([42; 32]).unwrap(), store.clone())
        .await
        .unwrap();
    let mut session = HostedSession::new(root);
    let material = session.allocate_pending_channel().await.unwrap();
    let identity = session.identity_public_key();
    let tenant = session.tenant_id().to_string();
    let snapshot = hex::encode(store.snapshot().unwrap());
    let state = serde_json::to_string(session.state()).unwrap();
    let signer = session
        .open_channel(session.pending_channel_key_id().unwrap())
        .await
        .unwrap();
    let remote = InMemorySigner::generate_from_seed(b"opening peer");
    let script = Script::new_builder().code_hash([3; 32].pack()).build();
    let commitment = Script::new_builder().code_hash([4; 32].pack()).build();
    let keys = material.base_public_keys.clone();
    let mut funding_keys = [keys.funding_pubkey, remote.funding_key.pubkey()];
    funding_keys.sort();
    let ctx = KeyAggContext::new(funding_keys).unwrap();
    let point: musig2::secp::Point = ctx.aggregated_pubkey();
    let lock_hash = blake2b_hash_with_salt(&point.serialize_xonly(), &[]);
    let mut ids = [
        keys.tlc_base_key.serialize(),
        remote.tlc_base_key.pubkey().serialize(),
    ];
    ids.sort();
    let id: fiber_types::Hash256 = blake2b_hash_with_salt(&ids.concat(), &[]).into();
    let input = OutPoint::new([7; 32].pack(), 0);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(input.clone(), 0))
        .input(CellInput::new(OutPoint::new([8; 32].pack(), 0), 0))
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(
                    script
                        .clone()
                        .as_builder()
                        .args(lock_hash[..20].to_vec().pack())
                        .build(),
                )
                .build(),
        )
        .output_data(ckb_types::packed::Bytes::default())
        .build()
        .data();
    let shutdown: ckb_jsonrpc_types::Script = script.clone().into();
    let reserve = CellOutput::new_builder()
        .lock(script.clone().as_builder().args([0u8; 58].pack()).build())
        .build()
        .occupied_capacity(ckb_types::core::Capacity::bytes(0).unwrap())
        .unwrap()
        .as_u64()
        + 100_000_000;
    let request: fiber_json_types::OpenChannelWithExternalFundingParams=serde_json::from_value(json!({"pubkey":remote.funding_key.pubkey(),"funding_amount":"0xba43b7400","public":false,"shutdown_script":shutdown,"funding_lock_script":shutdown,"commitment_delay_epoch":"0x10000000001","commitment_fee_rate":"0x3e8","funding_fee_rate":"0x3e8","external_channel_signer":fiber_lsp_sdk::json::open_material_to_rpc(&material)})).unwrap();
    let proposal = fiber_json_types::OpenChannelWithExternalFundingResult {
        channel_id: id.into(),
        unsigned_funding_tx: tx.clone().into(),
        opening_context: Some(fiber_json_types::TenantChannelOpeningContext {
            remote_funding_key: remote.funding_key.pubkey().into(),
            remote_settlement_key: remote.tlc_base_key.pubkey().into(),
            remote_shutdown_script: shutdown.clone(),
            commitment_delay_epoch: request.commitment_delay_epoch.unwrap(),
            commitment_fee_rate: 1000,
            local_amount: 50_000_000_000,
            remote_amount: 50_000_000_000,
            local_reserved_ckb_amount: reserve,
            remote_reserved_ckb_amount: reserve,
        }),
    };
    let commitment_template = TransactionBuilder::default()
        .cell_dep(ckb_types::packed::CellDep::default())
        .input(CellInput::default())
        .output(
            CellOutput::new_builder()
                .lock(
                    commitment
                        .clone()
                        .as_builder()
                        .args([0u8; 58].pack())
                        .build(),
                )
                .build(),
        )
        .output_data(ckb_types::packed::Bytes::default())
        .witness([0u8; 112].pack())
        .build();
    let fee = commitment_template.data().serialized_size_in_block() as u64;
    let mut statuses = vec![];
    for for_remote in [true, false] {
        let data = SettlementData {
            local_amount: 50_000_000_000,
            remote_amount: 50_000_000_000,
            tlcs: vec![],
        };
        let lock_ctx = KeyAggContext::new(if for_remote {
            [keys.funding_pubkey, remote.funding_key.pubkey()]
        } else {
            [remote.funding_key.pubkey(), keys.funding_pubkey]
        })
        .unwrap();
        let point: musig2::secp::Point = lock_ctx.aggregated_pubkey();
        let h = blake2b_hash_with_salt(&point.serialize_xonly(), &[]);
        let mut args = h[..20].to_vec();
        args.extend_from_slice(&(0xa000_0000_0000_0000u64 | 0x10000000001).to_le_bytes());
        args.extend_from_slice(&1u64.to_be_bytes());
        args.extend_from_slice(&settlement_witness_hash(
            &data,
            for_remote,
            CommitmentContractFeatures::LEGACY,
            keys.tlc_base_key,
            remote.tlc_base_key.pubkey(),
        ));
        args.push(0);
        let commitment_tx = TransactionBuilder::default()
            .input(CellInput::new(OutPoint::new(tx.calc_tx_hash(), 0), 0))
            .output(
                tx.raw()
                    .outputs()
                    .get(0)
                    .unwrap()
                    .as_builder()
                    .capacity(100_000_000_000 - fee)
                    .lock(commitment.clone().as_builder().args(args.pack()).build())
                    .build(),
            )
            .output_data(ckb_types::packed::Bytes::default())
            .build()
            .data();
        let mut signing_keys = [keys.funding_pubkey, remote.funding_key.pubkey()];
        signing_keys.sort();
        let ctx = KeyAggContext::new(signing_keys).unwrap();
        let slot = NonceSlot {
            purpose: NoncePurpose::Commitment,
            commitment_number: if for_remote { 1 } else { 2 },
        };
        // The outbound lane uses nonce one, then the local lane uses nonce two; the encoded
        // commitment version remains one for the opening baseline.
        let nonce = signer.get_musig2_nonce(slot).await.unwrap().public_nonce;
        let secnonce = musig2::SecNonce::build([if for_remote { 8 } else { 7 }; 32]).build();
        let peer_nonce = secnonce.public_nonce();
        let agg = AggNonce::sum([nonce, peer_nonce.clone()]);
        let content = Musig2SignableContent::CommitmentTransaction(commitment_tx);
        let partial = musig2::sign_partial(
            &ctx,
            remote.funding_key.clone(),
            secnonce,
            &agg,
            content.signing_message(),
        )
        .unwrap();
        let content = Musig2SigningContent {
            slot,
            commitment_counter: Some(CommitmentCounter::Local),
            key_agg_ctx: ctx,
            agg_nonce: agg,
            content,
        };
        let status = fiber_json_types::ChannelSigningStatus::SignatureRequired {
            request_id: fiber_types::Hash256::from([if for_remote { 2 } else { 1 }; 32]).into(),
            content: fiber_lsp_sdk::json::musig2_to_rpc(&content),
            transition: if for_remote {
                fiber_json_types::ChannelSigningTransition::SendCommitmentSigned
            } else {
                fiber_json_types::ChannelSigningTransition::CompleteReceivedCommitment
            },
            session_evidence: fiber_lsp_sdk::json::session_evidence_to_rpc(
                &SigningSessionEvidence {
                    peer_public_nonce: peer_nonce,
                    peer_partial_signature: (!for_remote).then_some(partial),
                },
            ),
            settlement: Some(fiber_json_types::SigningSettlement {
                local_amount: 50_000_000_000,
                remote_amount: 50_000_000_000,
                local_settlement_pubkey: keys.tlc_base_key.into(),
                remote_settlement_pubkey: remote.tlc_base_key.pubkey().into(),
                for_remote,
                tlcs: vec![],
            }),
        };
        statuses.push(status);
    }
    let close_template = TransactionBuilder::default()
        .input(CellInput::new(OutPoint::new(tx.calc_tx_hash(), 0), 0))
        .output(
            CellOutput::new_builder()
                .capacity(50_000_000_000u64)
                .lock(script.clone())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(50_000_000_000u64)
                .lock(script.clone())
                .build(),
        )
        .output_data(ckb_types::packed::Bytes::default())
        .output_data(ckb_types::packed::Bytes::default())
        .witness([0u8; 112].pack())
        .build();
    let close_fee = close_template.data().serialized_size_in_block() as u64;
    let close_tx = close_template
        .as_advanced_builder()
        .set_outputs(vec![
            close_template
                .outputs()
                .get(0)
                .unwrap()
                .as_builder()
                .capacity(50_000_000_000 - close_fee)
                .build(),
            close_template.outputs().get(1).unwrap(),
        ])
        .set_witnesses(vec![])
        .build()
        .data();
    let slot = NonceSlot {
        purpose: NoncePurpose::Commitment,
        commitment_number: 3,
    };
    let local_nonce = signer.get_musig2_nonce(slot).await.unwrap().public_nonce;
    let peer_nonce = musig2::SecNonce::build([11; 32]).build().public_nonce();
    let close_content = Musig2SigningContent {
        slot,
        commitment_counter: Some(CommitmentCounter::Local),
        key_agg_ctx: ctx,
        agg_nonce: AggNonce::sum([local_nonce, peer_nonce.clone()]),
        content: Musig2SignableContent::CooperativeCloseTransaction(close_tx.clone()),
    };
    let close_status = fiber_json_types::ChannelSigningStatus::SignatureRequired {
        request_id: fiber_types::Hash256::from([3; 32]).into(),
        content: fiber_lsp_sdk::json::musig2_to_rpc(&close_content),
        transition: fiber_json_types::ChannelSigningTransition::SendClosingSigned,
        session_evidence: fiber_lsp_sdk::json::session_evidence_to_rpc(&SigningSessionEvidence {
            peer_public_nonce: peer_nonce,
            peer_partial_signature: None,
        }),
        settlement: None,
    };
    let mut invoice = fiber_types::CkbInvoice {
        currency: fiber_types::Currency::Fibd,
        amount: Some(1000),
        signature: None,
        data: fiber_types::invoice::InvoiceData {
            timestamp: 1_700_000_000_000,
            payment_hash: fiber_types::HashAlgorithm::CkbHash.hash([9; 32]).into(),
            attrs: vec![
                fiber_types::invoice::Attribute::ExpiryTime(std::time::Duration::from_secs(
                    4_000_000_000,
                )),
                fiber_types::invoice::Attribute::PayeePublicKey(remote.funding_key.pubkey().into()),
                fiber_types::invoice::Attribute::FinalHtlcMinimumExpiryDelta(9_600_000),
            ],
        },
    };
    invoice
        .update_signature(|m| {
            musig2::secp256k1::SECP256K1.sign_ecdsa_recoverable(m, &remote.funding_key.0)
        })
        .unwrap();
    let fixture = json!({"closeStatus":close_status,"closeTransaction":ckb_jsonrpc_types::Transaction::from(close_tx),"invoiceObject":fiber_json_types::CkbInvoice::from(invoice.clone()),"invoice":invoice.to_string(),"root":hex::encode([42;32]),"snapshot":snapshot,"session":state,"tenantId":tenant,"publicKey":identity.to_string(),"nodePublicKey":remote.funding_key.pubkey(),"script":shutdown,"commitmentLock":ckb_jsonrpc_types::Script::from(commitment),"reserve":format!("0x{reserve:x}"),"proposal":proposal,"request":request,"statuses":statuses,"fundingCell":{"output":ckb_jsonrpc_types::CellOutput::from(tx.raw().outputs().get(0).unwrap()),"data":"0x"},"inputCell":{"output":{"capacity":format!("0x{:x}",50_000_001_000u64),"lock":shutdown,"type":null},"data":"0x"}});
    println!("{}", serde_json::to_string_pretty(&fixture).unwrap());
}
