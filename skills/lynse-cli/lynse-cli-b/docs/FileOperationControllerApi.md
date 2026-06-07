# FileOperationControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**aiModelProcessText**](FileOperationControllerApi.md#aiModelProcessText) | **POST** /api/business/file/ai | 
[**batchGetConclusions**](FileOperationControllerApi.md#batchGetConclusions) | **POST** /api/business/file/conclusion/batch | 
[**clearCompletedTodo**](FileOperationControllerApi.md#clearCompletedTodo) | **POST** /api/business/file/todo/clear | 
[**countTodoByDeadline**](FileOperationControllerApi.md#countTodoByDeadline) | **GET** /api/business/file/todo/count | 
[**deleteConclusion**](FileOperationControllerApi.md#deleteConclusion) | **DELETE** /api/business/file/conclusion/{conclusionId} | 
[**deleteTodo**](FileOperationControllerApi.md#deleteTodo) | **POST** /api/business/file/todo/delete | 
[**editConclusion**](FileOperationControllerApi.md#editConclusion) | **PUT** /api/business/file/conclusion/{conclusionId} | 
[**editMindMap**](FileOperationControllerApi.md#editMindMap) | **PUT** /api/business/file/mindMap/{mindMapId} | 
[**editOutline**](FileOperationControllerApi.md#editOutline) | **PUT** /api/business/file/outline/{outlineId} | 
[**editSpeakerInfo**](FileOperationControllerApi.md#editSpeakerInfo) | **PUT** /api/business/file/trans/speaker | 
[**editTransRecord**](FileOperationControllerApi.md#editTransRecord) | **PUT** /api/business/file/trans/edit | 
[**exportHtmlToPdf**](FileOperationControllerApi.md#exportHtmlToPdf) | **POST** /api/business/file/pdf/export | 
[**exportOutline**](FileOperationControllerApi.md#exportOutline) | **GET** /api/business/file/outline/export | 
[**exportTransRecord**](FileOperationControllerApi.md#exportTransRecord) | **GET** /api/business/file/trans/export | 
[**getAiTaskResult**](FileOperationControllerApi.md#getAiTaskResult) | **POST** /api/business/file/ai/result | 
[**getConclusion**](FileOperationControllerApi.md#getConclusion) | **GET** /api/business/file/conclusion/get | 
[**getConclusionList**](FileOperationControllerApi.md#getConclusionList) | **GET** /api/business/file/conclusion/list | 
[**getMindMap**](FileOperationControllerApi.md#getMindMap) | **GET** /api/business/file/mindMap/get | 
[**getOutline**](FileOperationControllerApi.md#getOutline) | **GET** /api/business/file/outline/get | 
[**getTranscribeStatus**](FileOperationControllerApi.md#getTranscribeStatus) | **POST** /api/business/file/trans/status | 
[**handleTransCallback**](FileOperationControllerApi.md#handleTransCallback) | **POST** /api/business/file/trans/callback | 
[**listTodoByDeadlineRange**](FileOperationControllerApi.md#listTodoByDeadlineRange) | **POST** /api/business/file/todo/list | 
[**listTranscriptionRecord**](FileOperationControllerApi.md#listTranscriptionRecord) | **GET** /api/business/file/trans/get | 
[**recoverTodo**](FileOperationControllerApi.md#recoverTodo) | **POST** /api/business/file/todo/recover | 
[**transferFile**](FileOperationControllerApi.md#transferFile) | **POST** /api/business/file/trans | 
[**updateFeedback**](FileOperationControllerApi.md#updateFeedback) | **PUT** /api/business/file/feedback | 
[**updateTodo**](FileOperationControllerApi.md#updateTodo) | **POST** /api/business/file/todo/update | 



## aiModelProcessText



### Example

```bash
 aiModelProcessText
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **aiTaskAddReq** | [**AiTaskAddReq**](AiTaskAddReq.md) |  |

### Return type

[**ResultString**](ResultString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## batchGetConclusions



### Example

```bash
 batchGetConclusions
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **batchConclusionRequestDTO** | [**BatchConclusionRequestDTO**](BatchConclusionRequestDTO.md) |  |

### Return type

[**ResultMapStringListFileConclusionVO**](ResultMapStringListFileConclusionVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## clearCompletedTodo



### Example

```bash
 clearCompletedTodo
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## countTodoByDeadline



### Example

```bash
 countTodoByDeadline
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultFileTodoCountVO**](ResultFileTodoCountVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## deleteConclusion



### Example

```bash
 deleteConclusion conclusionId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **conclusionId** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## deleteTodo



### Example

```bash
 deleteTodo
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileTodoIdsReq** | [**FileTodoIdsReq**](FileTodoIdsReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## editConclusion



### Example

```bash
 editConclusion conclusionId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **conclusionId** | **string** |  | [default to null]
 **fileConclusionUpdateReq** | [**FileConclusionUpdateReq**](FileConclusionUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## editMindMap



### Example

```bash
 editMindMap mindMapId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **mindMapId** | **string** |  | [default to null]
 **fileMindMapUpdateReq** | [**FileMindMapUpdateReq**](FileMindMapUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## editOutline



### Example

```bash
 editOutline outlineId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **outlineId** | **string** |  | [default to null]
 **fileOutlineUpdateReq** | [**FileOutlineUpdateReq**](FileOutlineUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## editSpeakerInfo



### Example

```bash
 editSpeakerInfo
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **speakerNameUpdateReq** | [**SpeakerNameUpdateReq**](SpeakerNameUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## editTransRecord



### Example

```bash
 editTransRecord
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileTransRecordUpdateReq** | [**array[FileTransRecordUpdateReq]**](FileTransRecordUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## exportHtmlToPdf



### Example

```bash
 exportHtmlToPdf
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **htmlToPdfReq** | [**HtmlToPdfReq**](HtmlToPdfReq.md) |  |

### Return type

(empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: Not Applicable

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## exportOutline



### Example

```bash
 exportOutline  fileId=value  sourceType=value  exportType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **sourceType** | **string** |  | [default to null]
 **exportType** | **string** |  | [default to null]

### Return type

(empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: Not Applicable

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## exportTransRecord



### Example

```bash
 exportTransRecord  fileId=value  sourceType=value  exportType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **sourceType** | **string** |  | [default to null]
 **exportType** | **string** |  | [default to null]

### Return type

(empty response body)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: Not Applicable

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getAiTaskResult



### Example

```bash
 getAiTaskResult
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **aiTaskResultQueryReq** | [**AiTaskResultQueryReq**](AiTaskResultQueryReq.md) |  |

### Return type

[**ResultAiTaskResultVO**](ResultAiTaskResultVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getConclusion



### Example

```bash
 getConclusion  fileId=value  teamId=value  taskId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **teamId** | **string** |  | [optional] [default to null]
 **taskId** | **string** |  | [optional] [default to null]

### Return type

[**ResultFileConclusionVO**](ResultFileConclusionVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getConclusionList



### Example

```bash
 getConclusionList  fileId=value  teamId=value  taskId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **teamId** | **string** |  | [optional] [default to null]
 **taskId** | **string** |  | [optional] [default to null]

### Return type

[**ResultListFileConclusionVO**](ResultListFileConclusionVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getMindMap



### Example

```bash
 getMindMap  fileId=value  teamId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **teamId** | **string** |  | [optional] [default to null]

### Return type

[**ResultFileMindMapVO**](ResultFileMindMapVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getOutline



### Example

```bash
 getOutline  fileId=value  teamId=value  taskId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **teamId** | **string** |  | [optional] [default to null]
 **taskId** | **string** |  | [optional] [default to null]

### Return type

[**ResultFileOutlineVO**](ResultFileOutlineVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getTranscribeStatus



### Example

```bash
 getTranscribeStatus
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **transcriptionStatus** | [**TranscriptionStatus**](TranscriptionStatus.md) |  |

### Return type

[**ResultMapStringTranscribeStatus**](ResultMapStringTranscribeStatus.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## handleTransCallback



### Example

```bash
 handleTransCallback
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **body** | **string** |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## listTodoByDeadlineRange



### Example

```bash
 listTodoByDeadlineRange
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **body** | **map** |  |

### Return type

[**TableDataInfoFileTodoDetailVO**](TableDataInfoFileTodoDetailVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## listTranscriptionRecord



### Example

```bash
 listTranscriptionRecord  taskId=value  teamId=value  fileId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **taskId** | **string** |  | [default to null]
 **teamId** | **string** |  | [default to null]
 **fileId** | **string** |  | [optional] [default to null]

### Return type

[**ResultListFileTransRecordVO**](ResultListFileTransRecordVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## recoverTodo



### Example

```bash
 recoverTodo
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileTodoIdsReq** | [**FileTodoIdsReq**](FileTodoIdsReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## transferFile



### Example

```bash
 transferFile
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **transferFileReq** | [**TransferFileReq**](TransferFileReq.md) |  |

### Return type

[**ResultSubmitTransResultVO**](ResultSubmitTransResultVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## updateFeedback



### Example

```bash
 updateFeedback
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **feedbackRequest** | [**FeedbackRequest**](FeedbackRequest.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## updateTodo



### Example

```bash
 updateTodo
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileTodoBatchUpdateReq** | [**FileTodoBatchUpdateReq**](FileTodoBatchUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

