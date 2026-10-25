//! Client-held account identity, recovery packages and fingerprint-checked pairing.
use super::*;
use libsodium_rs::crypto_box;
use reqwest::Method;
use sha2::{Digest, Sha256};

fn new_device(root: &Value, owner: &str) -> CommandResult<Sensitive> {
    crypto::init()?;
    let box_pair = crypto_box::KeyPair::generate();
    let seed = crypto::random_key()?;
    let id = uuid::Uuid::new_v4().to_string();
    let epoch = root["key_epoch"].as_u64().unwrap_or(1);
    let mut certificate = json!({"id":id,"box_public":crypto::encode(box_pair.public_key.as_ref()),"sign_public":crypto::sign_public(&seed)?,"key_epoch":epoch,"account_scope":owner});
    if let Some(authority) = root["authority_seed"].as_str() {
        certificate["certificate"] =
            json!(crypto::sign(&crypto::decode(authority)?, &certificate)?);
    }
    Ok(Sensitive(
        json!({"root_bundle":root,"device_id":id,"box_secret":crypto::encode(box_pair.secret_key.as_ref()),"box_public":crypto::encode(box_pair.public_key.as_ref()),"sign_seed":crypto::encode(&seed),"device":certificate}),
    ))
}
fn root_public(root: &Value) -> CommandResult<String> {
    crypto::sign_public(&crypto::decode(
        root["authority_seed"]
            .as_str()
            .ok_or("invalid_key_bundle")?,
    )?)
}
fn recovery_envelope(owner: &str, root: &Value, key: &[u8]) -> CommandResult<Envelope> {
    crypto::seal(
        key,
        &Zeroizing::new(serde_json::to_vec(root).map_err(|_| "invalid_key_bundle")?),
        &crypto::aad("recovery", owner, "", "", 1),
    )
}
#[tauri::command]
pub async fn inspiration_vault_initialize(
    app: AppHandle,
    mut password: String,
) -> CommandResult<Value> {
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    let result=async{
        let owner=scope(&app)?;
        if key_path(&app)?.exists(){return Err("device_package_already_exists".into())}
        let remote=cloud::request(&app,Method::GET,"/v2/vault",None,None).await?;
        if remote["initialized"]==true{return Err("trusted_device_or_recovery_required".into())}
        if remote["enabled"]!=true{return Err("private_storage_unavailable".into())}
        let root=Sensitive(json!({"keys":{"1":crypto::encode(&crypto::random_key()?)},"key_epoch":1,"authority_seed":crypto::encode(&crypto::random_key()?)}));
        let mut bundle=new_device(&root.0,&owner)?;
        bundle.0["require_recovery_confirmation"]=json!(true);
        let (code,recovery)=crypto::recovery_code()?;
        app.state::<PrivateState>().sensitive_seen.store(true,Ordering::SeqCst);
        let packet=json!({"root_public":root_public(&root.0)?,"recovery_envelope":recovery_envelope(&owner,&root.0,&recovery)?,"device":bundle.0["device"]});
        persist_bundle(&app,&password,&bundle.0)?;
        set_unlocked(&app,bundle.0.clone(),generation)?;
        let pending=key_path(&app)?.with_file_name("bootstrap.json");
        crate::atomic_write(&pending,&serde_json::to_vec(&packet).map_err(|_|"invalid_key_bundle")?)?;
        let op=format!("vault-bootstrap-{}",bundle.0["device_id"].as_str().ok_or("invalid_device")?);
        let response=cloud::request(&app,Method::POST,"/v2/vault",Some(&packet),Some(&op)).await;
        if let Err(error)=response{
            return Ok(json!({"recoveryCode":code,"cloudPending":true,"error":error}));
        }
        fs::remove_file(pending).map_err(|_|"storage_unavailable")?;
        set_unlocked(&app,bundle.0.clone(),generation)?;
        renew_transport(&app).await?;
        Ok(json!({"recoveryCode":code,"cloudPending":false}))
    }.await;
    password.zeroize();
    result
}
pub async fn finish_bootstrap(app: &AppHandle) -> CommandResult<()> {
    let path = key_path(app)?.with_file_name("bootstrap.json");
    if !path.exists() {
        return Ok(());
    }
    let packet: Value =
        serde_json::from_slice(&fs::read(&path).map_err(|_| "storage_unavailable")?)
            .map_err(|_| "invalid_key_bundle")?;
    let status = cloud::request(app, Method::GET, "/v2/vault", None, None).await?;
    if status["initialized"] == true {
        if status["vault"]["root_public"] != packet["root_public"] {
            return Err("vault_identity_conflict".into());
        }
    } else {
        cloud::request(
            app,
            Method::POST,
            "/v2/vault",
            Some(&packet),
            Some(&format!(
                "vault-bootstrap-{}",
                packet["device"]["id"].as_str().ok_or("invalid_device")?
            )),
        )
        .await?;
    }
    fs::remove_file(path).map_err(|_| "storage_unavailable".into())
}
#[tauri::command]
pub async fn inspiration_vault_recover(
    app: AppHandle,
    mut password: String,
    mut recovery_code: String,
) -> CommandResult<Value> {
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    let result = async {
        let owner = scope(&app)?;
        let status = cloud::request(&app, Method::GET, "/v2/vault", None, None).await?;
        let root = Sensitive(
            serde_json::from_slice(&crypto::open(
                &crypto::parse_recovery(&recovery_code)?,
                &serde_json::from_value(status["vault"]["recovery_envelope"].clone())
                    .map_err(|_| "invalid_recovery_package")?,
                &crypto::aad("recovery", &owner, "", "", 1),
            )?)
            .map_err(|_| "invalid_recovery_package")?,
        );
        if root_public(&root.0)? != status["vault"]["root_public"]
            || root.0["key_epoch"] != status["vault"]["key_epoch"]
        {
            return Err("recovery_package_mismatch".into());
        }
        let bundle = new_device(&root.0, &owner)?;
        cloud::request(
            &app,
            Method::POST,
            "/v2/vault/recover",
            Some(&json!({"device":bundle.0["device"]})),
            Some(&format!(
                "recover-{}",
                bundle.0["device_id"].as_str().ok_or("invalid_device")?
            )),
        )
        .await?;
        persist_bundle(&app, &password, &bundle.0)?;
        set_unlocked(&app, bundle.0.clone(), generation)?;
        renew_transport(&app).await?;
        Ok(json!({"unlocked":true}))
    }
    .await;
    password.zeroize();
    recovery_code.zeroize();
    result
}
fn request_fields(value: &Value) -> Value {
    let mut fields = json!({});
    for key in [
        "id",
        "device_id",
        "box_public",
        "sign_public",
        "challenge",
        "account_scope",
    ] {
        fields[key] = value[key].clone();
    }
    fields
}
fn fingerprint(request: &Value, root_public: &str) -> CommandResult<String> {
    let bytes =
        serde_json::to_vec(&json!({"request":request_fields(request),"root_public":root_public}))
            .map_err(|_| "invalid_pairing_request")?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok(hash[..32]
        .as_bytes()
        .chunks(8)
        .map(|p| std::str::from_utf8(p).expect("hex"))
        .collect::<Vec<_>>()
        .join("-"))
}
#[tauri::command]
pub async fn inspiration_vault_pair_request(
    app: AppHandle,
    mut password: String,
) -> CommandResult<Value> {
    let result=async{
        let owner=scope(&app)?;
        if key_path(&app)?.exists(){return Err("device_package_already_exists".into())}
        let status=cloud::request(&app,Method::GET,"/v2/vault",None,None).await?;
        if status["initialized"]!=true{return Err("vault_not_initialized".into())}
        let mut bundle=new_device(&Value::Null,&owner)?;
        let id=uuid::Uuid::new_v4().to_string();
        let request=json!({"id":id,"device_id":bundle.0["device_id"],"box_public":bundle.0["box_public"],"sign_public":bundle.0["device"]["sign_public"],"challenge":crypto::encode(&crypto::random_key()?),"account_scope":owner});
        bundle.0["pairing_request"]=request.clone();bundle.0["pinned_root_public"]=status["vault"]["root_public"].clone();
        cloud::request(&app,Method::POST,"/v2/vault/requests",Some(&request),Some(&format!("pair-{id}"))).await?;
        persist_bundle(&app,&password,&bundle.0)?;
        Ok(json!({"requestId":id,"fingerprint":fingerprint(&request,status["vault"]["root_public"].as_str().ok_or("invalid_vault_identity")?)?}))
    }.await;
    password.zeroize();
    result
}
#[tauri::command]
pub async fn inspiration_vault_pair_approve(
    app: AppHandle,
    request_id: String,
    expected_fingerprint: String,
) -> CommandResult<Value> {
    let request = cloud::request(
        &app,
        Method::GET,
        &format!("/v2/vault/requests/{request_id}"),
        None,
        None,
    )
    .await?;
    let owner = scope(&app)?;
    let (body, fp) = with_bundle(&app, |bundle| {
        let fp = fingerprint(&request, &root_public(&bundle["root_bundle"])?)?;
        if fp != expected_fingerprint.to_lowercase().trim() {
            return Err("pairing_fingerprint_mismatch".into());
        }
        let mut device = json!({"id":request["device_id"],"box_public":request["box_public"],"sign_public":request["sign_public"],"key_epoch":epoch(bundle)?,"account_scope":owner});
        device["certificate"] = json!(crypto::sign(
            &crypto::decode(
                bundle["root_bundle"]["authority_seed"]
                    .as_str()
                    .ok_or("invalid_key_bundle")?
            )?,
            &device
        )?);
        let public = crypto_box::PublicKey::from_bytes(&crypto::decode(
            request["box_public"].as_str().ok_or("invalid_device")?,
        )?)
        .map_err(|_| "invalid_device")?;
        let plain=Zeroizing::new(serde_json::to_vec(&json!({"root_bundle":bundle["root_bundle"],"request":request_fields(&request),"device":device})).map_err(|_|"invalid_key_bundle")?);
        let package =
            crypto_box::seal_box(&plain, &public).map_err(|_| "device_encryption_failed")?;
        Ok((
            json!({"device":device,"package":crypto::encode(&package)}),
            fp,
        ))
    })?;
    let body = cloud::sign_body(&app, "approve_device", body)?;
    cloud::request(
        &app,
        Method::POST,
        &format!("/v2/vault/requests/{request_id}/approve"),
        Some(&body),
        Some(&format!("approve-{request_id}")),
    )
    .await?;
    Ok(json!({"fingerprint":fp,"approved":true}))
}
#[tauri::command]
pub async fn inspiration_vault_pair_finish(
    app: AppHandle,
    request_id: String,
    mut password: String,
) -> CommandResult<Value> {
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    let result = async {
        // Unlock only the local pending package; it has no account content key yet.
        inspiration_vault_unlock(app.clone(), password.clone())?;
        let owner = scope(&app)?;
        let request = cloud::request(
            &app,
            Method::GET,
            &format!("/v2/vault/requests/{request_id}"),
            None,
            None,
        )
        .await?;
        if request["expires_at"].as_u64().unwrap_or(0)
            <= std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "invalid_system_clock")?
                .as_secs()
        {
            return Err("pairing_expired".into());
        }
        if request["state"] != "approved" {
            return Err("pairing_not_approved".into());
        }
        let complete = with_bundle(&app, |bundle| {
            if request_fields(&request) != bundle["pairing_request"] {
                return Err("pairing_request_changed".into());
            }
            let public = crypto_box::PublicKey::from_bytes(&crypto::decode(
                bundle["box_public"].as_str().ok_or("invalid_device")?,
            )?)
            .map_err(|_| "invalid_device")?;
            let secret = crypto_box::SecretKey::from_bytes(&crypto::decode(
                bundle["box_secret"].as_str().ok_or("invalid_device")?,
            )?)
            .map_err(|_| "invalid_device")?;
            let bytes = Zeroizing::new(
                crypto_box::open_sealed_box(
                    &crypto::decode(
                        request["package"]
                            .as_str()
                            .ok_or("invalid_pairing_package")?,
                    )?,
                    &public,
                    &secret,
                )
                .map_err(|_| "invalid_pairing_package")?,
            );
            let received = Sensitive(
                serde_json::from_slice::<Value>(&bytes).map_err(|_| "invalid_pairing_package")?,
            );
            if received.0["request"] != request_fields(&request)
                || root_public(&received.0["root_bundle"])? != bundle["pinned_root_public"]
            {
                return Err("pairing_fingerprint_mismatch".into());
            }
            let mut cert = received.0["device"].clone();
            let signature = cert
                .as_object_mut()
                .ok_or("invalid_device")?
                .remove("certificate")
                .ok_or("invalid_device")?;
            crypto::verify(
                bundle["pinned_root_public"]
                    .as_str()
                    .ok_or("invalid_device")?,
                signature.as_str().ok_or("invalid_device")?,
                &cert,
            )?;
            if cert["account_scope"] != owner || cert["id"] != bundle["device_id"] {
                return Err("device_scope_mismatch".into());
            }
            let mut result = bundle.clone();
            result["root_bundle"] = received.0["root_bundle"].clone();
            result["device"] = received.0["device"].clone();
            result["completed_pairing"] = json!(request_id);
            for key in ["pairing_request", "pinned_root_public"] {
                result.as_object_mut().ok_or("invalid_device")?.remove(key);
            }
            Ok(Sensitive(result))
        })?;
        persist_bundle(&app, &password, &complete.0)?;
        set_unlocked(&app, complete.0.clone(), generation)?;
        consume_pairing(&app, &request_id).await?;
        renew_transport(&app).await?;
        Ok(json!({"unlocked":true}))
    }
    .await;
    password.zeroize();
    result
}
#[tauri::command]
pub async fn inspiration_vault_devices(app: AppHandle) -> CommandResult<Value> {
    cloud::request(&app, Method::GET, "/v2/vault/devices", None, None).await
}

pub async fn refresh(app: &AppHandle) -> CommandResult<()> {
    refresh_inner(app, None).await
}
async fn refresh_inner(app: &AppHandle, password: Option<&str>) -> CommandResult<()> {
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    if with_bundle(app, |b| Ok(!b["root_bundle"].is_null())).unwrap_or(false) == false {
        return Ok(());
    }
    let completed = with_bundle(app, |bundle| {
        Ok(bundle["completed_pairing"].as_str().map(str::to_owned))
    })?;
    if let Some(id) = completed {
        consume_pairing(app, &id).await?;
    }
    let status = cloud::request(app, Method::GET, "/v2/vault", None, None).await?;
    let (device, epoch_local) = with_bundle(app, |b| {
        Ok((
            b["device_id"].as_str().ok_or("invalid_device")?.to_owned(),
            epoch(b)?,
        ))
    })?;
    let remote_epoch = status["vault"]["key_epoch"]
        .as_u64()
        .ok_or("invalid_vault_identity")?;
    if remote_epoch < epoch_local {
        return Err("vault_revision_rollback".into());
    }
    let devices = cloud::request(app, Method::GET, "/v2/vault/devices", None, None).await?;
    let current = devices["devices"]
        .as_array()
        .and_then(|a| a.iter().find(|d| d["id"] == device));
    if current.is_none_or(|d| d["revoked_at"].as_str().is_some_and(|s| !s.is_empty())) {
        lock(app);
        return Err("device_revoked".into());
    }
    if remote_epoch == epoch_local {
        renew_transport(app).await?;
        return Ok(());
    }
    let password = password.ok_or("device_key_refresh_required")?;
    let current = current.ok_or("device_revoked")?;
    let updated = with_bundle(app, |bundle| {
        let mut trusted = root_public(&bundle["root_bundle"])?;
        let mut expected = epoch_local;
        for link in status["vault"]["rotation_links"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if link["from_epoch"].as_u64() != Some(expected) {
                continue;
            }
            let fields = json!({"from_epoch":link["from_epoch"],"to_epoch":link["to_epoch"],"old_public":link["old_public"],"new_public":link["new_public"]});
            if fields["old_public"] != trusted || fields["to_epoch"].as_u64() != Some(expected + 1)
            {
                return Err("invalid_rotation_trust".into());
            }
            crypto::verify(
                &trusted,
                link["signature"].as_str().ok_or("invalid_rotation_trust")?,
                &fields,
            )?;
            trusted = link["new_public"]
                .as_str()
                .ok_or("invalid_rotation_trust")?
                .into();
            expected += 1;
        }
        if expected != remote_epoch || status["vault"]["root_public"] != trusted {
            return Err("invalid_rotation_trust".into());
        }
        let pk = crypto_box::PublicKey::from_bytes(&crypto::decode(
            bundle["box_public"].as_str().ok_or("invalid_device")?,
        )?)
        .map_err(|_| "invalid_device")?;
        let sk = crypto_box::SecretKey::from_bytes(&crypto::decode(
            bundle["box_secret"].as_str().ok_or("invalid_device")?,
        )?)
        .map_err(|_| "invalid_device")?;
        let bytes = Zeroizing::new(
            crypto_box::open_sealed_box(
                &crypto::decode(
                    current["package"]
                        .as_str()
                        .ok_or("invalid_device_package")?,
                )?,
                &pk,
                &sk,
            )
            .map_err(|_| "invalid_device_package")?,
        );
        let roots =
            Sensitive(serde_json::from_slice(&bytes).map_err(|_| "invalid_device_package")?);
        if root_public(&roots.0)? != trusted || roots.0["key_epoch"].as_u64() != Some(remote_epoch)
        {
            return Err("invalid_device_package".into());
        }
        let certificate = json!({"id":current["id"],"box_public":current["box_public"],"sign_public":current["sign_public"],"key_epoch":current["key_epoch"],"account_scope":current["account_scope"]});
        if certificate["id"] != bundle["device_id"]
            || certificate["box_public"] != bundle["box_public"]
        {
            return Err("invalid_device_package".into());
        }
        crypto::verify(
            &trusted,
            current["certificate"]
                .as_str()
                .ok_or("invalid_device_package")?,
            &certificate,
        )?;
        let mut next = bundle.clone();
        next["root_bundle"] = roots.0.clone();
        next["device"] = current.clone();
        Ok(Sensitive(next))
    })?;
    persist_bundle(app, password, &updated.0)?;
    set_unlocked(app, updated.0.clone(), generation)?;
    renew_transport(app).await?;
    Ok(())
}
#[tauri::command]
pub async fn inspiration_vault_refresh(app: AppHandle, mut password: String) -> CommandResult<()> {
    let result = refresh_inner(&app, Some(&password)).await;
    password.zeroize();
    result
}
fn open_pending(app: &AppHandle, password: &str, path: &Path) -> CommandResult<Sensitive> {
    let raw: Value =
        serde_json::from_slice(&fs::read(path).map_err(|_| "rotation_package_unavailable")?)
            .map_err(|_| "invalid_key_bundle")?;
    if raw["account_scope"] != scope(app)? || raw["passes"] != 3 || raw["memory"] != 268435456u64 {
        return Err("invalid_key_bundle".into());
    }
    let key = crypto::local_key(
        password.as_bytes(),
        &credential(app, false)?,
        &crypto::decode(raw["salt"].as_str().ok_or("invalid_key_bundle")?)?,
        &scope(app)?,
    )?;
    let plain = crypto::open(
        &key,
        &serde_json::from_value(raw["envelope"].clone()).map_err(|_| "invalid_key_bundle")?,
        &crypto::aad("device-package", &scope(app)?, "", "", 1),
    )?;
    Ok(Sensitive(
        serde_json::from_slice(&plain).map_err(|_| "invalid_key_bundle")?,
    ))
}
async fn finish_rotation(
    app: &AppHandle,
    password: &str,
    packet: &Value,
    pending: &Sensitive,
    generation: u64,
) -> CommandResult<Value> {
    let operation = packet["operation_id"].as_str().ok_or("invalid_rotation")?;
    let status = cloud::request(app, Method::GET, "/v2/vault", None, None).await?;
    if status["vault"]["key_epoch"] != packet["body"]["key_epoch"]
        || status["vault"]["root_public"] != packet["body"]["root_public"]
    {
        for upload in packet["uploads"].as_array().into_iter().flatten() {
            for spec in upload["files"].as_array().into_iter().flatten() {
                cloud::upload(
                    app,
                    upload["id"].as_str().ok_or("invalid_record")?,
                    spec,
                    operation,
                )
                .await?;
            }
        }
        cloud::request(
            app,
            Method::POST,
            "/v2/vault/rotate",
            Some(&packet["body"]),
            Some(operation),
        )
        .await?;
    }
    let remote = cloud::request(app, Method::GET, "/v2/vault", None, None).await?;
    if remote["vault"]["root_public"] != packet["body"]["root_public"] {
        return Err("vault_identity_conflict".into());
    }
    let code = pending.0["pending_recovery_code"]
        .as_str()
        .ok_or("invalid_key_bundle")?
        .to_owned();
    let mut bundle = Sensitive(pending.0.clone());
    bundle
        .0
        .as_object_mut()
        .ok_or("invalid_key_bundle")?
        .remove("pending_recovery_code");
    persist_bundle(app, password, &bundle.0)?;
    set_unlocked(app, bundle.0.clone(), generation)?;
    renew_transport(app).await?;
    for row in packet["records"].as_array().into_iter().flatten() {
        let mut row = row.clone();
        row["version"] = json!(row["version"].as_u64().unwrap_or(0) + 1);
        put(app, &row)?;
        cloud::cleanup_conversion(app, &row)?;
    }
    fs::remove_file(key_path(app)?.with_file_name("rotation-operation.json"))
        .map_err(|_| "storage_unavailable")?;
    fs::remove_file(key_path(app)?.with_file_name("rotation-device.json"))
        .map_err(|_| "storage_unavailable")?;
    Ok(json!({"recoveryCode":code}))
}
#[tauri::command]
pub async fn inspiration_vault_rotate(
    app: AppHandle,
    revoke: Vec<String>,
    mut password: String,
    full_reencrypt: bool,
) -> CommandResult<Value> {
    let generation = app
        .state::<PrivateState>()
        .generation
        .load(Ordering::SeqCst);
    let result=async{
        inspiration_vault_unlock(app.clone(),password.clone())?;
        let packet_path=key_path(&app)?.with_file_name("rotation-operation.json");
        let pending_path=key_path(&app)?.with_file_name("rotation-device.json");
        if packet_path.exists(){
            let packet:Value=serde_json::from_slice(&fs::read(&packet_path).map_err(|_|"storage_unavailable")?).map_err(|_|"invalid_rotation")?;
            let pending=open_pending(&app,&password,&pending_path)?;
            return finish_rotation(&app,&password,&packet,&pending,generation).await;
        }
        refresh_inner(&app,Some(&password)).await?;
        if !cloud::ops(&app)?.is_empty(){return Err("sync_before_key_rotation".into())}
        let token={let state=app.state::<PrivateState>();let token=state.token.lock().map_err(|_|"cloud_offline")?;token.as_ref().ok_or("cloud_offline")?.to_string()};
        cloud::sync(&app,token).await?;
        let state = app.state::<PrivateState>(); let _sync = state.sync.lock().await;
        let registry=cloud::request(&app,Method::GET,"/v2/vault/devices",None,None).await?;
        let (new_root,mut bundle,link)=with_bundle(&app,|b|{
            if revoke.iter().any(|id|b["device_id"]==*id){return Err("cannot_revoke_current_device".into())}
            let mut root=Sensitive(b["root_bundle"].clone());let next=epoch(b)?+1;
            root.0["key_epoch"]=json!(next);root.0["keys"][next.to_string()]=json!(crypto::encode(&crypto::random_key()?));root.0["authority_seed"]=json!(crypto::encode(&crypto::random_key()?));
            let fields=json!({"from_epoch":epoch(b)?,"to_epoch":next,"old_public":root_public(&b["root_bundle"])?,"new_public":root_public(&root.0)?});
            let mut link=fields.clone();link["signature"]=json!(crypto::sign(&crypto::decode(b["root_bundle"]["authority_seed"].as_str().ok_or("invalid_key_bundle")?)?,&fields)?);
            let mut bundle=Sensitive(b.clone());bundle.0["root_bundle"]=root.0.clone();Ok((root,bundle,link))
        })?;
        let next=new_root.0["key_epoch"].as_u64().ok_or("invalid_key_bundle")?;
        let owner=scope(&app)?;let public=root_public(&new_root.0)?;
        let (code,recovery)=crypto::recovery_code()?;
        app.state::<PrivateState>().sensitive_seen.store(true,Ordering::SeqCst);
        let root_key=crypto::decode(new_root.0["keys"][next.to_string()].as_str().ok_or("invalid_key_bundle")?)?;
        let mut records=Vec::new();let mut changes=Vec::new();let mut uploads=Vec::new();
        for row in crate::read_array(&index_path(&app)?)?.iter().filter(|r|r["protection"]=="e2ee"&&r["deletedAt"].is_null()){
            let rotated=cloud::rotation_record(&app,row,&root_key,next,full_reencrypt)?;
            let mut change=json!({"id":row["id"],"base_version":row["version"]});
            if full_reencrypt{change["envelope"]=rotated["envelope"].clone();change["content_revision"]=rotated["content_revision"].clone();change["media_ids"]=rotated["media_ids"].clone();uploads.push(json!({"id":row["id"],"files":cloud::file_specs(&app,&rotated)?}));}
            else{change["wrapped_key"]=rotated["envelope"]["wrapped_key"].clone();}
            changes.push(change);records.push(rotated);
        }
        let mut devices=Vec::new();
        for device in registry["devices"].as_array().ok_or("invalid_device_registry")?.iter().filter(|d|d["revoked_at"].as_str().is_none_or(str::is_empty)){
            let id=device["id"].as_str().ok_or("invalid_device")?;if revoke.iter().any(|r|r==id){continue}
            let mut certificate=json!({"id":id,"box_public":device["box_public"],"sign_public":device["sign_public"],"key_epoch":next,"account_scope":owner});
            certificate["certificate"]=json!(crypto::sign(&crypto::decode(new_root.0["authority_seed"].as_str().ok_or("invalid_key_bundle")?)?,&certificate)?);
            let pk=crypto_box::PublicKey::from_bytes(&crypto::decode(device["box_public"].as_str().ok_or("invalid_device")?)?).map_err(|_|"invalid_device")?;
            certificate["package"]=json!(crypto::encode(&crypto_box::seal_box(&Zeroizing::new(serde_json::to_vec(&new_root.0).map_err(|_|"invalid_key_bundle")?),&pk).map_err(|_|"device_encryption_failed")?));
            if bundle.0["device_id"]==id{bundle.0["device"]=certificate.clone();}devices.push(certificate);
        }
        let body=cloud::sign_body(&app,"rotate",json!({"key_epoch":next,"root_public":public,"recovery_envelope":recovery_envelope(&owner,&new_root.0,&recovery)?,"devices":devices,"revoke":revoke,"records":changes,"rotation_link":link}))?;
        let packet=json!({"operation_id":uuid::Uuid::new_v4().to_string(),"body":body,"records":records,"uploads":uploads});
        bundle.0["require_recovery_confirmation"]=json!(true);
        bundle.0["pending_recovery_code"]=json!(code);
        persist_bundle_at(&app,&password,&bundle.0,&pending_path)?;
        crate::atomic_write(&packet_path,&serde_json::to_vec(&packet).map_err(|_|"invalid_rotation")?)?;
        finish_rotation(&app,&password,&packet,&bundle,generation).await
    }.await;
    password.zeroize();
    result
}

async fn consume_pairing(app: &AppHandle, id: &str) -> CommandResult<()> {
    let body = cloud::sign_body(app, "consume_request", json!({"request_id":id}))?;
    cloud::request(
        app,
        Method::POST,
        &format!("/v2/vault/requests/{id}/consume"),
        Some(&body),
        Some(&format!("consume-{id}")),
    )
    .await?;
    Ok(())
}
async fn renew_transport(app: &AppHandle) -> CommandResult<()> {
    let issued = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "invalid_system_clock")?
        .as_secs();
    let body = cloud::sign_body(
        app,
        "session",
        json!({"issued_at":issued,"nonce":crypto::encode(&crypto::random_key()?)}),
    )?;
    let session = cloud::request(app, Method::POST, "/v2/vault/session", Some(&body), None).await?;
    let token = session["session"]
        .as_str()
        .ok_or("invalid_device_session")?;
    *app.state::<PrivateState>()
        .transport
        .lock()
        .map_err(|_| "session_unavailable")? =
        Some((scope(app)?, Zeroizing::new(token.to_owned())));
    Ok(())
}
