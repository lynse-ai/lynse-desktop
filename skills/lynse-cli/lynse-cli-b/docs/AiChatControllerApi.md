# AiChatControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**chatStream**](AiChatControllerApi.md#chatStream) | **POST** /api/business/ai/chat/stream | 
[**listChatFiles**](AiChatControllerApi.md#listChatFiles) | **GET** /api/business/ai/chat/files | 



## chatStream



### Example

```bash
 chatStream
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **aiChatStreamReq** | [**AiChatStreamReq**](AiChatStreamReq.md) |  |

### Return type

**map**

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: text/event-stream

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## listChatFiles



### Example

```bash
 listChatFiles
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListAiChatFileVO**](ResultListAiChatFileVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

