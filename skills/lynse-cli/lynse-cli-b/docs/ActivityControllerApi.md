# ActivityControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**claim**](ActivityControllerApi.md#claim) | **POST** /api/business/activity/claim | 
[**claimByActivityId**](ActivityControllerApi.md#claimByActivityId) | **POST** /api/business/activity/claimByActivityId | 
[**list4**](ActivityControllerApi.md#list4) | **GET** /api/business/activity/list | 



## claim



### Example

```bash
 claim
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultInteger**](ResultInteger.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## claimByActivityId



### Example

```bash
 claimByActivityId
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **activityClaimReq** | [**ActivityClaimReq**](ActivityClaimReq.md) |  |

### Return type

[**ResultInteger**](ResultInteger.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## list4



### Example

```bash
 list4
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListAppActivityVO**](ResultListAppActivityVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

