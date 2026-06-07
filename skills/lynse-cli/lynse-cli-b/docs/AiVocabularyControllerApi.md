# AiVocabularyControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**bindVocabulary**](AiVocabularyControllerApi.md#bindVocabulary) | **POST** /api/business/ai/vocabulary/bind | 
[**getBoundVocabulary**](AiVocabularyControllerApi.md#getBoundVocabulary) | **GET** /api/business/ai/vocabulary/bound | 
[**listEnabledVocabularies**](AiVocabularyControllerApi.md#listEnabledVocabularies) | **GET** /api/business/ai/vocabulary/enabled | 
[**unbindVocabulary**](AiVocabularyControllerApi.md#unbindVocabulary) | **DELETE** /api/business/ai/vocabulary/bind | 



## bindVocabulary



### Example

```bash
 bindVocabulary
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **vocabularyBindReq** | [**VocabularyBindReq**](VocabularyBindReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getBoundVocabulary



### Example

```bash
 getBoundVocabulary
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultAiTranscribeVocabularyEnabledVO**](ResultAiTranscribeVocabularyEnabledVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## listEnabledVocabularies



### Example

```bash
 listEnabledVocabularies
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListAiTranscribeVocabularyEnabledVO**](ResultListAiTranscribeVocabularyEnabledVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## unbindVocabulary



### Example

```bash
 unbindVocabulary
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

