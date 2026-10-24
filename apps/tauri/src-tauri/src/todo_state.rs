//! Versioned local todo state. Business todo ownership stays on its backend.
use serde_json::{json,Value};
pub fn status(todo: &Value) -> &str {
    todo["status"].as_str().filter(|s| matches!(*s,"open"|"doing"|"done"|"cancelled"))
        .unwrap_or(if todo["completed"]==true {"done"} else {"open"})
}
pub fn transition(current: &Value, request: &Value, timestamp: &str) -> Result<Value,String> {
    let next=request["status"].as_str().filter(|s|matches!(*s,"open"|"doing"|"done"|"cancelled")).ok_or("Invalid todo state")?;
    let operation=request["operationId"].as_str().filter(|s|!s.is_empty() && s.len()<=200).ok_or("Stable operation ID required")?;
    let version=request["baseVersion"].as_u64().ok_or("Todo base version required")?;
    let fingerprint=json!([current["id"],next,version]).to_string();
    let mut history=current["statusHistory"].as_array().cloned().unwrap_or_default();
    if let Some(prior)=history.iter().find(|entry|entry["operationId"]==operation) {
        if prior["request"]!=fingerprint {return Err("Todo operation conflict".into());}
        return Ok(current.clone());
    }
    if current["statusVersion"].as_u64().unwrap_or(0)!=version {return Err("Todo version conflict".into());}
    let mut saved=current.clone();
    history.push(json!({"operationId":operation,"request":fingerprint,"from":status(current),"to":next,"at":timestamp,"version":version+1}));
    saved["status"]=json!(next);saved["statusVersion"]=json!(version+1);saved["statusHistory"]=json!(history);
    saved["completed"]=json!(next=="done");saved["updatedAt"]=json!(timestamp);
    Ok(saved)
}
pub fn preserve_status(current: &Value, proposed: &mut Value) -> Result<(),String> {
    if current["statusVersion"].as_u64().unwrap_or(0)>0 {
        if current["completed"]!=proposed["completed"] || proposed.get("status").is_some_and(|s|s!=&current["status"]) {
            return Err("Use the versioned todo state action".into());
        }
        for key in ["status","statusVersion","statusHistory"] {proposed[key]=current[key].clone();}
    } else {
        // A legacy edit cannot forge versioned history or a new state.
        for key in ["status","statusVersion","statusHistory"] {proposed.as_object_mut().ok_or("Invalid todo")?.remove(key);}
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn states_versions_and_operation_replay() {
        let old=json!({"id":"one","completed":false});
        let action=json!({"status":"doing","baseVersion":0,"operationId":"operation-1"});
        let doing=transition(&old,&action,"now").unwrap();assert_eq!(doing["completed"],false);
        assert_eq!(transition(&doing,&action,"later").unwrap(),doing);
        let mut conflicting=action.clone();conflicting["status"]=json!("done");assert!(transition(&doing,&conflicting,"later").is_err());
        let cancelled=transition(&doing,&json!({"status":"cancelled","baseVersion":1,"operationId":"operation-2"}),"later").unwrap();
        assert_eq!(cancelled["completed"],false);assert_eq!(cancelled["statusHistory"].as_array().unwrap().len(),2);
        let mut legacy=json!({"id":"one","completed":true});assert!(preserve_status(&cancelled,&mut legacy).is_err());
    }
}
