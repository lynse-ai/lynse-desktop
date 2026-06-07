# PushControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**init**](PushControllerApi.md#init) | **POST** /api/business/push/init | 
[**testAndroidPush**](PushControllerApi.md#testAndroidPush) | **POST** /api/business/push/android/test | 
[**testIosPush**](PushControllerApi.md#testIosPush) | **POST** /api/business/push/ios/test | 



## init



### Example

```bash
 init
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **pushInitReq** | [**PushInitReq**](PushInitReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## testAndroidPush



### Example

```bash
 testAndroidPush
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **umengAndroidPushReq** | [**UmengAndroidPushReq**](UmengAndroidPushReq.md) |  |

### Return type

[**ResultJSONObject**](ResultJSONObject.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## testIosPush



### Example

```bash
 testIosPush
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **umengIosPushReq** | [**UmengIosPushReq**](UmengIosPushReq.md) |  |

### Return type

[**ResultJSONObject**](ResultJSONObject.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

