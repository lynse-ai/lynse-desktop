# OpenAPI definition Bash client

## Overview

This is a Bash client script for accessing OpenAPI definition service.

The script uses cURL underneath for making all REST calls.

## Usage

```shell
# Make sure the script has executable rights
$ chmod u+x 

# Print the list of operations available on the service
$ ./ -h

# Print the service description
$ ./ --about

# Print detailed information about specific operation
$ ./ <operationId> -h

# Make GET request
./ --host http://<hostname>:<port> --accept xml <operationId> <queryParam1>=<value1> <header_key1>:<header_value2>

# Make GET request using arbitrary curl options (must be passed before <operationId>) to an SSL service using username:password
 -k -sS --tlsv1.2 --host https://<hostname> -u <user>:<password> --accept xml <operationId> <queryParam1>=<value1> <header_key1>:<header_value2>

# Make POST request
$ echo '<body_content>' |  --host <hostname> --content-type json <operationId> -

# Make POST request with simple JSON content, e.g.:
# {
#   "key1": "value1",
#   "key2": "value2",
#   "key3": 23
# }
$ echo '<body_content>' |  --host <hostname> --content-type json <operationId> key1==value1 key2=value2 key3:=23 -

# Make POST request with form data
$  --host <hostname> <operationId> key1:=value1 key2:=value2 key3:=23

# Preview the cURL command without actually executing it
$  --host http://<hostname>:<port> --dry-run <operationid>

```

## Docker image

You can easily create a Docker image containing a preconfigured environment
for using the REST Bash client including working autocompletion and short
welcome message with basic instructions, using the generated Dockerfile:

```shell
docker build -t my-rest-client .
docker run -it my-rest-client
```

By default you will be logged into a Zsh environment which has much more
advanced auto completion, but you can switch to Bash, where basic autocompletion
is also available.

## Shell completion

### Bash

The generated bash-completion script can be either directly loaded to the current Bash session using:

```shell
source .bash-completion
```

Alternatively, the script can be copied to the `/etc/bash-completion.d` (or on OSX with Homebrew to `/usr/local/etc/bash-completion.d`):

```shell
sudo cp .bash-completion /etc/bash-completion.d/
```

#### OS X

On OSX you might need to install bash-completion using Homebrew:

```shell
brew install bash-completion
```

and add the following to the `~/.bashrc`:

```shell
if [ -f $(brew --prefix)/etc/bash_completion ]; then
  . $(brew --prefix)/etc/bash_completion
fi
```

### Zsh

In Zsh, the generated `_` Zsh completion file must be copied to one of the folders under `$FPATH` variable.

## Documentation for API Endpoints

All URIs are relative to **

Class | Method | HTTP request | Description
------------ | ------------- | ------------- | -------------
*ActivityControllerApi* | [**claim**](docs/ActivityControllerApi.md#claim) | **POST** /api/business/activity/claim | 
*ActivityControllerApi* | [**claimByActivityId**](docs/ActivityControllerApi.md#claimbyactivityid) | **POST** /api/business/activity/claimByActivityId | 
*ActivityControllerApi* | [**list4**](docs/ActivityControllerApi.md#list4) | **GET** /api/business/activity/list | 
*AiChatControllerApi* | [**chatStream**](docs/AiChatControllerApi.md#chatstream) | **POST** /api/business/ai/chat/stream | 
*AiChatControllerApi* | [**listChatFiles**](docs/AiChatControllerApi.md#listchatfiles) | **GET** /api/business/ai/chat/files | 
*AiVocabularyControllerApi* | [**bindVocabulary**](docs/AiVocabularyControllerApi.md#bindvocabulary) | **POST** /api/business/ai/vocabulary/bind | 
*AiVocabularyControllerApi* | [**getBoundVocabulary**](docs/AiVocabularyControllerApi.md#getboundvocabulary) | **GET** /api/business/ai/vocabulary/bound | 
*AiVocabularyControllerApi* | [**listEnabledVocabularies**](docs/AiVocabularyControllerApi.md#listenabledvocabularies) | **GET** /api/business/ai/vocabulary/enabled | 
*AiVocabularyControllerApi* | [**unbindVocabulary**](docs/AiVocabularyControllerApi.md#unbindvocabulary) | **DELETE** /api/business/ai/vocabulary/bind | 
*AuditControllerApi* | [**auditText**](docs/AuditControllerApi.md#audittext) | **POST** /api/business/audit/text | 
*BenefitControllerApi* | [**list3**](docs/BenefitControllerApi.md#list3) | **GET** /api/business/benefit/list | 
*BusinessPoolControllerApi* | [**getPoolStatus**](docs/BusinessPoolControllerApi.md#getpoolstatus) | **GET** /api/business/pool/status | 
*CustomerControllerApi* | [**changeTeam**](docs/CustomerControllerApi.md#changeteam) | **GET** /api/business/customer/changeTeam | 
*CustomerControllerApi* | [**current**](docs/CustomerControllerApi.md#current) | **GET** /api/business/customer/current | 
*CustomerControllerApi* | [**detail**](docs/CustomerControllerApi.md#detail) | **GET** /api/business/customer/detail | 
*CustomerControllerApi* | [**edit2**](docs/CustomerControllerApi.md#edit2) | **PUT** /api/business/customer | 
*CustomerControllerApi* | [**edit3**](docs/CustomerControllerApi.md#edit3) | **PUT** /api/business/customer/{customerId} | 
*CustomerControllerApi* | [**grantDurationPackage**](docs/CustomerControllerApi.md#grantdurationpackage) | **POST** /api/business/customer/membership/package/grant | 
*CustomerControllerApi* | [**grantMonthlyReward**](docs/CustomerControllerApi.md#grantmonthlyreward) | **GET** /api/business/customer/bonus | 
*CustomerControllerApi* | [**grantTeamUpgrade**](docs/CustomerControllerApi.md#grantteamupgrade) | **GET** /api/business/customer/grantTeamUpgrade | 
*CustomerControllerApi* | [**list2**](docs/CustomerControllerApi.md#list2) | **GET** /api/business/customer/list | 
*CustomerControllerApi* | [**outPutLanguage**](docs/CustomerControllerApi.md#outputlanguage) | **PUT** /api/business/customer/outPutLanguage | 
*CustomerControllerApi* | [**recharge1**](docs/CustomerControllerApi.md#recharge1) | **POST** /api/business/customer/recharge | 
*CustomerControllerApi* | [**rechargeMembership**](docs/CustomerControllerApi.md#rechargemembership) | **POST** /api/business/customer/membership/recharge | 
*CustomerControllerApi* | [**refreshMembershipQuota**](docs/CustomerControllerApi.md#refreshmembershipquota) | **GET** /api/business/customer/membership/refresh | 
*CustomerControllerApi* | [**register**](docs/CustomerControllerApi.md#register) | **POST** /api/business/customer/register | 
*CustomerControllerApi* | [**syncMembership**](docs/CustomerControllerApi.md#syncmembership) | **POST** /api/business/customer/membership/sync | 
*CustomerControllerApi* | [**terminate**](docs/CustomerControllerApi.md#terminate) | **DELETE** /api/business/customer | 
*CustomerControllerApi* | [**updatePwd**](docs/CustomerControllerApi.md#updatepwd) | **PUT** /api/business/customer/updatePwd | 
*DeviceControllerApi* | [**bind**](docs/DeviceControllerApi.md#bind) | **POST** /api/business/device/bind | 
*DeviceControllerApi* | [**isBound**](docs/DeviceControllerApi.md#isbound) | **GET** /api/business/device/isBound | 
*DeviceControllerApi* | [**listMyBindingDeviceList**](docs/DeviceControllerApi.md#listmybindingdevicelist) | **GET** /api/business/device/mine | 
*DeviceControllerApi* | [**unbind**](docs/DeviceControllerApi.md#unbind) | **GET** /api/business/device/unbind | 
*DeviceControllerApi* | [**update**](docs/DeviceControllerApi.md#update) | **PUT** /api/business/device/update | 
*DeviceControllerApi* | [**updateConnectTime**](docs/DeviceControllerApi.md#updateconnecttime) | **PUT** /api/business/device/updateConnectTime | 
*FileControllerApi* | [**addEvaluation**](docs/FileControllerApi.md#addevaluation) | **POST** /api/business/file/evaluation/add | 
*FileControllerApi* | [**changeFolder**](docs/FileControllerApi.md#changefolder) | **GET** /api/business/file/changeFolder | 
*FileControllerApi* | [**cleanBin**](docs/FileControllerApi.md#cleanbin) | **POST** /api/business/file/cleanBin | 
*FileControllerApi* | [**cleanBinAll**](docs/FileControllerApi.md#cleanbinall) | **POST** /api/business/file/cleanBinAll | 
*FileControllerApi* | [**countByCategory**](docs/FileControllerApi.md#countbycategory) | **GET** /api/business/file/category/count | 
*FileControllerApi* | [**createSyncUploadPlaceholder**](docs/FileControllerApi.md#createsyncuploadplaceholder) | **POST** /api/business/file/sync/pre/create | 
*FileControllerApi* | [**delete**](docs/FileControllerApi.md#delete) | **DELETE** /api/business/file/delete | 
*FileControllerApi* | [**edit**](docs/FileControllerApi.md#edit) | **PUT** /api/business/file/{fileId} | 
*FileControllerApi* | [**getAvailableAIModelList**](docs/FileControllerApi.md#getavailableaimodellist) | **GET** /api/business/file/getAvailableAIModelList | 
*FileControllerApi* | [**getEvaluationList**](docs/FileControllerApi.md#getevaluationlist) | **GET** /api/business/file/getEvaluationList | 
*FileControllerApi* | [**getStsToken**](docs/FileControllerApi.md#getststoken) | **POST** /api/business/file/getStsToken | 
*FileControllerApi* | [**getSupportLanguage**](docs/FileControllerApi.md#getsupportlanguage) | **GET** /api/business/file/getSupportLanguage | 
*FileControllerApi* | [**getSyncStsToken**](docs/FileControllerApi.md#getsyncststoken) | **POST** /api/business/file/sync/pre/sts | 
*FileControllerApi* | [**handleAudioMergeCallback**](docs/FileControllerApi.md#handleaudiomergecallback) | **POST** /api/business/file/audio/merge/callback | 
*FileControllerApi* | [**info1**](docs/FileControllerApi.md#info1) | **GET** /api/business/file/info | 
*FileControllerApi* | [**list**](docs/FileControllerApi.md#list) | **GET** /api/business/file/list | 
*FileControllerApi* | [**listByCategory**](docs/FileControllerApi.md#listbycategory) | **GET** /api/business/file/category/list | 
*FileControllerApi* | [**listByCategoryV1**](docs/FileControllerApi.md#listbycategoryv1) | **GET** /api/business/file/category | 
*FileControllerApi* | [**listByTimeRange**](docs/FileControllerApi.md#listbytimerange) | **GET** /api/business/file/timeRange/list | 
*FileControllerApi* | [**markFileAsRead**](docs/FileControllerApi.md#markfileasread) | **GET** /api/business/file/markRead | 
*FileControllerApi* | [**notify**](docs/FileControllerApi.md#notify) | **GET** /api/business/file/upload/notify | 
*FileControllerApi* | [**notifySyncUpload**](docs/FileControllerApi.md#notifysyncupload) | **GET** /api/business/file/sync/pre/notify | 
*FileControllerApi* | [**page**](docs/FileControllerApi.md#page) | **GET** /api/business/file/page | 
*FileControllerApi* | [**pageByCategory**](docs/FileControllerApi.md#pagebycategory) | **GET** /api/business/file/category/page | 
*FileControllerApi* | [**presign4Download**](docs/FileControllerApi.md#presign4download) | **GET** /api/business/file/presign/download | 
*FileControllerApi* | [**presign4Upload**](docs/FileControllerApi.md#presign4upload) | **POST** /api/business/file/presign/upload | 
*FileControllerApi* | [**presign4UploadForPublic**](docs/FileControllerApi.md#presign4uploadforpublic) | **POST** /api/business/file/presign/uploadPublic | 
*FileControllerApi* | [**queryAudioMergeStatus**](docs/FileControllerApi.md#queryaudiomergestatus) | **GET** /api/business/file/audio/merge/status | 
*FileControllerApi* | [**recover**](docs/FileControllerApi.md#recover) | **POST** /api/business/file/recover | 
*FileControllerApi* | [**removeOss**](docs/FileControllerApi.md#removeoss) | **DELETE** /api/business/file/removeOss | 
*FileControllerApi* | [**submitAudioMerge**](docs/FileControllerApi.md#submitaudiomerge) | **POST** /api/business/file/audio/merge | 
*FileControllerApi* | [**testAudioMerge**](docs/FileControllerApi.md#testaudiomerge) | **POST** /api/business/file/audio/merge/test | 
*FileOperationControllerApi* | [**aiModelProcessText**](docs/FileOperationControllerApi.md#aimodelprocesstext) | **POST** /api/business/file/ai | 
*FileOperationControllerApi* | [**batchGetConclusions**](docs/FileOperationControllerApi.md#batchgetconclusions) | **POST** /api/business/file/conclusion/batch | 
*FileOperationControllerApi* | [**clearCompletedTodo**](docs/FileOperationControllerApi.md#clearcompletedtodo) | **POST** /api/business/file/todo/clear | 
*FileOperationControllerApi* | [**countTodoByDeadline**](docs/FileOperationControllerApi.md#counttodobydeadline) | **GET** /api/business/file/todo/count | 
*FileOperationControllerApi* | [**deleteConclusion**](docs/FileOperationControllerApi.md#deleteconclusion) | **DELETE** /api/business/file/conclusion/{conclusionId} | 
*FileOperationControllerApi* | [**deleteTodo**](docs/FileOperationControllerApi.md#deletetodo) | **POST** /api/business/file/todo/delete | 
*FileOperationControllerApi* | [**editConclusion**](docs/FileOperationControllerApi.md#editconclusion) | **PUT** /api/business/file/conclusion/{conclusionId} | 
*FileOperationControllerApi* | [**editMindMap**](docs/FileOperationControllerApi.md#editmindmap) | **PUT** /api/business/file/mindMap/{mindMapId} | 
*FileOperationControllerApi* | [**editOutline**](docs/FileOperationControllerApi.md#editoutline) | **PUT** /api/business/file/outline/{outlineId} | 
*FileOperationControllerApi* | [**editSpeakerInfo**](docs/FileOperationControllerApi.md#editspeakerinfo) | **PUT** /api/business/file/trans/speaker | 
*FileOperationControllerApi* | [**editTransRecord**](docs/FileOperationControllerApi.md#edittransrecord) | **PUT** /api/business/file/trans/edit | 
*FileOperationControllerApi* | [**exportHtmlToPdf**](docs/FileOperationControllerApi.md#exporthtmltopdf) | **POST** /api/business/file/pdf/export | 
*FileOperationControllerApi* | [**exportOutline**](docs/FileOperationControllerApi.md#exportoutline) | **GET** /api/business/file/outline/export | 
*FileOperationControllerApi* | [**exportTransRecord**](docs/FileOperationControllerApi.md#exporttransrecord) | **GET** /api/business/file/trans/export | 
*FileOperationControllerApi* | [**getAiTaskResult**](docs/FileOperationControllerApi.md#getaitaskresult) | **POST** /api/business/file/ai/result | 
*FileOperationControllerApi* | [**getConclusion**](docs/FileOperationControllerApi.md#getconclusion) | **GET** /api/business/file/conclusion/get | 
*FileOperationControllerApi* | [**getConclusionList**](docs/FileOperationControllerApi.md#getconclusionlist) | **GET** /api/business/file/conclusion/list | 
*FileOperationControllerApi* | [**getMindMap**](docs/FileOperationControllerApi.md#getmindmap) | **GET** /api/business/file/mindMap/get | 
*FileOperationControllerApi* | [**getOutline**](docs/FileOperationControllerApi.md#getoutline) | **GET** /api/business/file/outline/get | 
*FileOperationControllerApi* | [**getTranscribeStatus**](docs/FileOperationControllerApi.md#gettranscribestatus) | **POST** /api/business/file/trans/status | 
*FileOperationControllerApi* | [**handleTransCallback**](docs/FileOperationControllerApi.md#handletranscallback) | **POST** /api/business/file/trans/callback | 
*FileOperationControllerApi* | [**listTodoByDeadlineRange**](docs/FileOperationControllerApi.md#listtodobydeadlinerange) | **POST** /api/business/file/todo/list | 
*FileOperationControllerApi* | [**listTranscriptionRecord**](docs/FileOperationControllerApi.md#listtranscriptionrecord) | **GET** /api/business/file/trans/get | 
*FileOperationControllerApi* | [**recoverTodo**](docs/FileOperationControllerApi.md#recovertodo) | **POST** /api/business/file/todo/recover | 
*FileOperationControllerApi* | [**transferFile**](docs/FileOperationControllerApi.md#transferfile) | **POST** /api/business/file/trans | 
*FileOperationControllerApi* | [**updateFeedback**](docs/FileOperationControllerApi.md#updatefeedback) | **PUT** /api/business/file/feedback | 
*FileOperationControllerApi* | [**updateTodo**](docs/FileOperationControllerApi.md#updatetodo) | **POST** /api/business/file/todo/update | 
*FolderControllerApi* | [**add**](docs/FolderControllerApi.md#add) | **POST** /api/business/file/folder/add | 
*FolderControllerApi* | [**batchUpdateSort**](docs/FolderControllerApi.md#batchupdatesort) | **PUT** /api/business/file/folder/batch-update-sort | 
*FolderControllerApi* | [**edit1**](docs/FolderControllerApi.md#edit1) | **PUT** /api/business/file/folder/{folderId} | 
*FolderControllerApi* | [**list1**](docs/FolderControllerApi.md#list1) | **GET** /api/business/file/folder/list | 
*FolderControllerApi* | [**selectOne**](docs/FolderControllerApi.md#selectone) | **GET** /api/business/file/folder/{folderId} | 
*OtaControllerApi* | [**checkApkUpdate**](docs/OtaControllerApi.md#checkapkupdate) | **GET** /api/business/ota/app/check | 
*OtaControllerApi* | [**checkVersion**](docs/OtaControllerApi.md#checkversion) | **GET** /api/business/ota/check | 
*OtaControllerApi* | [**getFunctionList**](docs/OtaControllerApi.md#getfunctionlist) | **GET** /api/business/ota/function/list | 
*OtaControllerApi* | [**presignUrl**](docs/OtaControllerApi.md#presignurl) | **GET** /api/business/ota/presign | 
*PointsLogControllerApi* | [**queryPointsLog**](docs/PointsLogControllerApi.md#querypointslog) | **GET** /api/business/pointsLog/queryPointsLog | 
*PushControllerApi* | [**init**](docs/PushControllerApi.md#init) | **POST** /api/business/push/init | 
*PushControllerApi* | [**testAndroidPush**](docs/PushControllerApi.md#testandroidpush) | **POST** /api/business/push/android/test | 
*PushControllerApi* | [**testIosPush**](docs/PushControllerApi.md#testiospush) | **POST** /api/business/push/ios/test | 
*RedemptionControllerApi* | [**redeem**](docs/RedemptionControllerApi.md#redeem) | **POST** /api/business/redemption/redeem | 
*ShareLinkControllerApi* | [**generateShareLink**](docs/ShareLinkControllerApi.md#generatesharelink) | **POST** /api/business/share | 
*ShareLinkControllerApi* | [**getSharedInfo**](docs/ShareLinkControllerApi.md#getsharedinfo) | **GET** /api/business/share/{shareId} | 
*TeamControllerApi* | [**allocatePointsToTeam**](docs/TeamControllerApi.md#allocatepointstoteam) | **POST** /api/business/team/points/allocate | 
*TeamControllerApi* | [**assignRole**](docs/TeamControllerApi.md#assignrole) | **GET** /api/business/team/member/assign | 
*TeamControllerApi* | [**checkTeamAdminOrOwner**](docs/TeamControllerApi.md#checkteamadminorowner) | **GET** /api/business/team/checkAdmin | 
*TeamControllerApi* | [**createTeam**](docs/TeamControllerApi.md#createteam) | **POST** /api/business/team/create | 
*TeamControllerApi* | [**deleteTeam**](docs/TeamControllerApi.md#deleteteam) | **DELETE** /api/business/team/{teamId} | 
*TeamControllerApi* | [**editTeam**](docs/TeamControllerApi.md#editteam) | **PUT** /api/business/team/{teamId} | 
*TeamControllerApi* | [**info**](docs/TeamControllerApi.md#info) | **GET** /api/business/team/{teamId} | 
*TeamControllerApi* | [**leaveTeam**](docs/TeamControllerApi.md#leaveteam) | **GET** /api/business/team/leave | 
*TeamControllerApi* | [**listMyTeam**](docs/TeamControllerApi.md#listmyteam) | **GET** /api/business/team | 
*TeamControllerApi* | [**recharge**](docs/TeamControllerApi.md#recharge) | **POST** /api/business/team/recharge | 
*TeamControllerApi* | [**removeTeamMember**](docs/TeamControllerApi.md#removeteammember) | **GET** /api/business/team/member/remove | 
*TeamFileControllerApi* | [**editTeamFile**](docs/TeamFileControllerApi.md#editteamfile) | **PUT** /api/business/team/file/{fileId} | 
*TeamFileControllerApi* | [**getFileInfo**](docs/TeamFileControllerApi.md#getfileinfo) | **GET** /api/business/team/file/info | 
*TeamFileControllerApi* | [**listTeamFile**](docs/TeamFileControllerApi.md#listteamfile) | **GET** /api/business/team/file/list | 
*TeamFileControllerApi* | [**moveOrCopy**](docs/TeamFileControllerApi.md#moveorcopy) | **POST** /api/business/team/file/share | 
*TeamFileControllerApi* | [**removeTeamFile**](docs/TeamFileControllerApi.md#removeteamfile) | **DELETE** /api/business/team/file/remove | 
*TeamInviteControllerApi* | [**createInvitation**](docs/TeamInviteControllerApi.md#createinvitation) | **POST** /api/business/team/invite/create | 
*TeamInviteControllerApi* | [**handleInvite**](docs/TeamInviteControllerApi.md#handleinvite) | **GET** /api/business/team/invite/{invitationId} | 
*TeamInviteControllerApi* | [**listMyInvitation**](docs/TeamInviteControllerApi.md#listmyinvitation) | **GET** /api/business/team/invite/mine | 
*TranslateControllerApi* | [**getLatestSpeakerNames**](docs/TranslateControllerApi.md#getlatestspeakernames) | **GET** /api/business/translate/speaker/history | 
*TranslateControllerApi* | [**getPromptTemplateCategories**](docs/TranslateControllerApi.md#getprompttemplatecategories) | **GET** /api/business/translate/prompt/categories | 
*TranslateControllerApi* | [**getRegenerateSelectList**](docs/TranslateControllerApi.md#getregenerateselectlist) | **GET** /api/business/translate/regenerate/select | 
*TranslateControllerApi* | [**getTranscriptionLanguageList**](docs/TranslateControllerApi.md#gettranscriptionlanguagelist) | **GET** /api/business/translate/languages | 
*TranslateControllerApi* | [**getTranslateHistory**](docs/TranslateControllerApi.md#gettranslatehistory) | **GET** /api/business/translate/history | 
*TranslateControllerApi* | [**getTranslateResult**](docs/TranslateControllerApi.md#gettranslateresult) | **GET** /api/business/translate/result | 


## Documentation For Models

 - [ActivityClaimReq](docs/ActivityClaimReq.md)
 - [AiChatFileVO](docs/AiChatFileVO.md)
 - [AiChatStreamReq](docs/AiChatStreamReq.md)
 - [AiTaskAddReq](docs/AiTaskAddReq.md)
 - [AiTaskResultQueryReq](docs/AiTaskResultQueryReq.md)
 - [AiTaskResultVO](docs/AiTaskResultVO.md)
 - [AiTranscribeVocabularyEnabledVO](docs/AiTranscribeVocabularyEnabledVO.md)
 - [AliyunAudioMergeReq](docs/AliyunAudioMergeReq.md)
 - [AliyunAudioMergeTaskVO](docs/AliyunAudioMergeTaskVO.md)
 - [ApkManagementVO](docs/ApkManagementVO.md)
 - [AppActivityVO](docs/AppActivityVO.md)
 - [AudioMergeSubmitReq](docs/AudioMergeSubmitReq.md)
 - [AudioMergeSubmitVO](docs/AudioMergeSubmitVO.md)
 - [AudioMergeTaskStatusVO](docs/AudioMergeTaskStatusVO.md)
 - [AudioSegment](docs/AudioSegment.md)
 - [AuditTextReq](docs/AuditTextReq.md)
 - [BatchConclusionRequestDTO](docs/BatchConclusionRequestDTO.md)
 - [BenefitInfoVO](docs/BenefitInfoVO.md)
 - [BonusVO](docs/BonusVO.md)
 - [ConclusionContentDto](docs/ConclusionContentDto.md)
 - [CustomerDurationPackageGrantReq](docs/CustomerDurationPackageGrantReq.md)
 - [CustomerExtInfoVO](docs/CustomerExtInfoVO.md)
 - [CustomerInfoVO](docs/CustomerInfoVO.md)
 - [CustomerMembershipQuotaVO](docs/CustomerMembershipQuotaVO.md)
 - [CustomerMembershipRechargeReq](docs/CustomerMembershipRechargeReq.md)
 - [CustomerMembershipSyncReq](docs/CustomerMembershipSyncReq.md)
 - [CustomerQueryReq](docs/CustomerQueryReq.md)
 - [CustomerRechargeReq](docs/CustomerRechargeReq.md)
 - [CustomerRegisterReq](docs/CustomerRegisterReq.md)
 - [CustomerUpdateReq](docs/CustomerUpdateReq.md)
 - [DeviceBindVO](docs/DeviceBindVO.md)
 - [DeviceBindingStatusVO](docs/DeviceBindingStatusVO.md)
 - [DeviceInfoVO](docs/DeviceInfoVO.md)
 - [DeviceUpdateDTO](docs/DeviceUpdateDTO.md)
 - [EvaluationOptions](docs/EvaluationOptions.md)
 - [EvaluationResultAddReq](docs/EvaluationResultAddReq.md)
 - [FeedbackRequest](docs/FeedbackRequest.md)
 - [FileActionVO](docs/FileActionVO.md)
 - [FileCategoryQueryReq](docs/FileCategoryQueryReq.md)
 - [FileCategoryVO](docs/FileCategoryVO.md)
 - [FileConclusionUpdateReq](docs/FileConclusionUpdateReq.md)
 - [FileConclusionVO](docs/FileConclusionVO.md)
 - [FileIdsReq](docs/FileIdsReq.md)
 - [FileInfoDTO](docs/FileInfoDTO.md)
 - [FileInfoVO](docs/FileInfoVO.md)
 - [FileListQueryReq](docs/FileListQueryReq.md)
 - [FileMindMapUpdateReq](docs/FileMindMapUpdateReq.md)
 - [FileMindMapVO](docs/FileMindMapVO.md)
 - [FileOutlineUpdateReq](docs/FileOutlineUpdateReq.md)
 - [FileOutlineVO](docs/FileOutlineVO.md)
 - [FileQueryReq](docs/FileQueryReq.md)
 - [FileShareInfoVO](docs/FileShareInfoVO.md)
 - [FileTimeRangeQueryReq](docs/FileTimeRangeQueryReq.md)
 - [FileTodoBatchUpdateReq](docs/FileTodoBatchUpdateReq.md)
 - [FileTodoCountVO](docs/FileTodoCountVO.md)
 - [FileTodoDetailVO](docs/FileTodoDetailVO.md)
 - [FileTodoIdsReq](docs/FileTodoIdsReq.md)
 - [FileTransRecordUpdateReq](docs/FileTransRecordUpdateReq.md)
 - [FileTransRecordVO](docs/FileTransRecordVO.md)
 - [FileUpdateReq](docs/FileUpdateReq.md)
 - [FolderAddOrEditReq](docs/FolderAddOrEditReq.md)
 - [FolderEntity](docs/FolderEntity.md)
 - [FolderInfoVO](docs/FolderInfoVO.md)
 - [FolderQueryReq](docs/FolderQueryReq.md)
 - [FolderSortInfo](docs/FolderSortInfo.md)
 - [FolderSortUpdateReq](docs/FolderSortUpdateReq.md)
 - [FolderStats](docs/FolderStats.md)
 - [FunctionManageVO](docs/FunctionManageVO.md)
 - [GenerateInviteReq](docs/GenerateInviteReq.md)
 - [GeneratePresignedUrlResult](docs/GeneratePresignedUrlResult.md)
 - [GenerateShareLinkVO](docs/GenerateShareLinkVO.md)
 - [GenerateShareReq](docs/GenerateShareReq.md)
 - [HtmlToPdfReq](docs/HtmlToPdfReq.md)
 - [LanguageListDTO](docs/LanguageListDTO.md)
 - [ModelListDTO](docs/ModelListDTO.md)
 - [OtaManagementVO](docs/OtaManagementVO.md)
 - [PageQuery](docs/PageQuery.md)
 - [PointsLog](docs/PointsLog.md)
 - [PointsLogQueryReq](docs/PointsLogQueryReq.md)
 - [PreSignedUrlVO](docs/PreSignedUrlVO.md)
 - [PreUploadReq](docs/PreUploadReq.md)
 - [PromptTemplateCategoryResp](docs/PromptTemplateCategoryResp.md)
 - [PromptTemplateItemVO](docs/PromptTemplateItemVO.md)
 - [PromptTemplateSelectVO](docs/PromptTemplateSelectVO.md)
 - [PushInitReq](docs/PushInitReq.md)
 - [RedemptionCodeRedeemReq](docs/RedemptionCodeRedeemReq.md)
 - [RedemptionRedeemResultVO](docs/RedemptionRedeemResultVO.md)
 - [ResultAiTaskResultVO](docs/ResultAiTaskResultVO.md)
 - [ResultAiTranscribeVocabularyEnabledVO](docs/ResultAiTranscribeVocabularyEnabledVO.md)
 - [ResultAliyunAudioMergeTaskVO](docs/ResultAliyunAudioMergeTaskVO.md)
 - [ResultApkManagementVO](docs/ResultApkManagementVO.md)
 - [ResultAudioMergeSubmitVO](docs/ResultAudioMergeSubmitVO.md)
 - [ResultAudioMergeTaskStatusVO](docs/ResultAudioMergeTaskStatusVO.md)
 - [ResultBonusVO](docs/ResultBonusVO.md)
 - [ResultBoolean](docs/ResultBoolean.md)
 - [ResultCustomerExtInfoVO](docs/ResultCustomerExtInfoVO.md)
 - [ResultCustomerInfoVO](docs/ResultCustomerInfoVO.md)
 - [ResultCustomerMembershipQuotaVO](docs/ResultCustomerMembershipQuotaVO.md)
 - [ResultFileCategoryVO](docs/ResultFileCategoryVO.md)
 - [ResultFileConclusionVO](docs/ResultFileConclusionVO.md)
 - [ResultFileInfoVO](docs/ResultFileInfoVO.md)
 - [ResultFileMindMapVO](docs/ResultFileMindMapVO.md)
 - [ResultFileOutlineVO](docs/ResultFileOutlineVO.md)
 - [ResultFileShareInfoVO](docs/ResultFileShareInfoVO.md)
 - [ResultFileTodoCountVO](docs/ResultFileTodoCountVO.md)
 - [ResultFolderEntity](docs/ResultFolderEntity.md)
 - [ResultGeneratePresignedUrlResult](docs/ResultGeneratePresignedUrlResult.md)
 - [ResultGenerateShareLinkVO](docs/ResultGenerateShareLinkVO.md)
 - [ResultInteger](docs/ResultInteger.md)
 - [ResultJSONObject](docs/ResultJSONObject.md)
 - [ResultJSONObjectData](docs/ResultJSONObjectData.md)
 - [ResultListAiChatFileVO](docs/ResultListAiChatFileVO.md)
 - [ResultListAiTranscribeVocabularyEnabledVO](docs/ResultListAiTranscribeVocabularyEnabledVO.md)
 - [ResultListAppActivityVO](docs/ResultListAppActivityVO.md)
 - [ResultListBenefitInfoVO](docs/ResultListBenefitInfoVO.md)
 - [ResultListCustomerInfoVO](docs/ResultListCustomerInfoVO.md)
 - [ResultListDeviceBindingStatusVO](docs/ResultListDeviceBindingStatusVO.md)
 - [ResultListDeviceInfoVO](docs/ResultListDeviceInfoVO.md)
 - [ResultListEvaluationOptions](docs/ResultListEvaluationOptions.md)
 - [ResultListFileActionVO](docs/ResultListFileActionVO.md)
 - [ResultListFileConclusionVO](docs/ResultListFileConclusionVO.md)
 - [ResultListFileInfoVO](docs/ResultListFileInfoVO.md)
 - [ResultListFileTransRecordVO](docs/ResultListFileTransRecordVO.md)
 - [ResultListFolderInfoVO](docs/ResultListFolderInfoVO.md)
 - [ResultListFunctionManageVO](docs/ResultListFunctionManageVO.md)
 - [ResultListLanguageListDTO](docs/ResultListLanguageListDTO.md)
 - [ResultListModelListDTO](docs/ResultListModelListDTO.md)
 - [ResultListPromptTemplateCategoryResp](docs/ResultListPromptTemplateCategoryResp.md)
 - [ResultListPromptTemplateSelectVO](docs/ResultListPromptTemplateSelectVO.md)
 - [ResultListString](docs/ResultListString.md)
 - [ResultListTeamFileInfoVO](docs/ResultListTeamFileInfoVO.md)
 - [ResultListTeamInfoVO](docs/ResultListTeamInfoVO.md)
 - [ResultListTeamMemberInviteVO](docs/ResultListTeamMemberInviteVO.md)
 - [ResultListTranscriptionLanguageVO](docs/ResultListTranscriptionLanguageVO.md)
 - [ResultListTranslateHistoryVO](docs/ResultListTranslateHistoryVO.md)
 - [ResultMapStringListFileConclusionVO](docs/ResultMapStringListFileConclusionVO.md)
 - [ResultMapStringTranscribeStatus](docs/ResultMapStringTranscribeStatus.md)
 - [ResultOtaManagementVO](docs/ResultOtaManagementVO.md)
 - [ResultPreSignedUrlVO](docs/ResultPreSignedUrlVO.md)
 - [ResultRedemptionRedeemResultVO](docs/ResultRedemptionRedeemResultVO.md)
 - [ResultString](docs/ResultString.md)
 - [ResultStsTokenVO](docs/ResultStsTokenVO.md)
 - [ResultSubmitTransResultVO](docs/ResultSubmitTransResultVO.md)
 - [ResultTeamFileInfoVO](docs/ResultTeamFileInfoVO.md)
 - [ResultTeamInfoVO](docs/ResultTeamInfoVO.md)
 - [SpeakerInfo](docs/SpeakerInfo.md)
 - [SpeakerNameUpdateReq](docs/SpeakerNameUpdateReq.md)
 - [StsTokenVO](docs/StsTokenVO.md)
 - [SubmitTransResultVO](docs/SubmitTransResultVO.md)
 - [SyncPreUploadReq](docs/SyncPreUploadReq.md)
 - [TableDataInfoFileInfoVO](docs/TableDataInfoFileInfoVO.md)
 - [TableDataInfoFileTodoDetailVO](docs/TableDataInfoFileTodoDetailVO.md)
 - [TableDataInfoPointsLog](docs/TableDataInfoPointsLog.md)
 - [TeamAddOrEditReq](docs/TeamAddOrEditReq.md)
 - [TeamFileAddReq](docs/TeamFileAddReq.md)
 - [TeamFileInfoVO](docs/TeamFileInfoVO.md)
 - [TeamFileUpdateReq](docs/TeamFileUpdateReq.md)
 - [TeamInfoVO](docs/TeamInfoVO.md)
 - [TeamMemberInfoVO](docs/TeamMemberInfoVO.md)
 - [TeamMemberInviteVO](docs/TeamMemberInviteVO.md)
 - [TeamRechargeReq](docs/TeamRechargeReq.md)
 - [TodoUpdateItem](docs/TodoUpdateItem.md)
 - [TranscriptionLanguageVO](docs/TranscriptionLanguageVO.md)
 - [TranscriptionStatus](docs/TranscriptionStatus.md)
 - [TransferFileReq](docs/TransferFileReq.md)
 - [TranslateHistoryVO](docs/TranslateHistoryVO.md)
 - [UmengAndroidPushReq](docs/UmengAndroidPushReq.md)
 - [UmengIosPushReq](docs/UmengIosPushReq.md)
 - [VocabularyBindReq](docs/VocabularyBindReq.md)


## Documentation For Authorization

 All endpoints do not require authorization.

