# ShareLinkControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**generateShareLink**](ShareLinkControllerApi.md#generateShareLink) | **POST** /api/business/share | 
[**getSharedInfo**](ShareLinkControllerApi.md#getSharedInfo) | **GET** /api/business/share/{shareId} | 



## generateShareLink



### Example

```bash
 generateShareLink
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **generateShareReq** | [**GenerateShareReq**](GenerateShareReq.md) |  |

### Return type

[**ResultGenerateShareLinkVO**](ResultGenerateShareLinkVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getSharedInfo



### Example

```bash
 getSharedInfo shareId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **shareId** | **string** |  | [default to null]

### Return type

[**ResultFileShareInfoVO**](ResultFileShareInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

