# TranslateControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**getLatestSpeakerNames**](TranslateControllerApi.md#getLatestSpeakerNames) | **GET** /api/business/translate/speaker/history | 
[**getPromptTemplateCategories**](TranslateControllerApi.md#getPromptTemplateCategories) | **GET** /api/business/translate/prompt/categories | 
[**getRegenerateSelectList**](TranslateControllerApi.md#getRegenerateSelectList) | **GET** /api/business/translate/regenerate/select | 
[**getTranscriptionLanguageList**](TranslateControllerApi.md#getTranscriptionLanguageList) | **GET** /api/business/translate/languages | 
[**getTranslateHistory**](TranslateControllerApi.md#getTranslateHistory) | **GET** /api/business/translate/history | 
[**getTranslateResult**](TranslateControllerApi.md#getTranslateResult) | **GET** /api/business/translate/result | 



## getLatestSpeakerNames



### Example

```bash
 getLatestSpeakerNames
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListString**](ResultListString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getPromptTemplateCategories



### Example

```bash
 getPromptTemplateCategories
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListPromptTemplateCategoryResp**](ResultListPromptTemplateCategoryResp.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getRegenerateSelectList



### Example

```bash
 getRegenerateSelectList
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListPromptTemplateSelectVO**](ResultListPromptTemplateSelectVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getTranscriptionLanguageList



### Example

```bash
 getTranscriptionLanguageList  fileId=value  textType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [optional] [default to null]
 **textType** | **string** |  | [optional] [default to null]

### Return type

[**ResultListTranscriptionLanguageVO**](ResultListTranscriptionLanguageVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getTranslateHistory



### Example

```bash
 getTranslateHistory  fileId=value  textType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **textType** | **string** |  | [optional] [default to null]

### Return type

[**ResultListTranslateHistoryVO**](ResultListTranslateHistoryVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getTranslateResult



### Example

```bash
 getTranslateResult  fileId=value  targetLanguage=value  textType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **targetLanguage** | **string** |  | [default to null]
 **textType** | **string** |  | [default to null]

### Return type

[**ResultString**](ResultString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

