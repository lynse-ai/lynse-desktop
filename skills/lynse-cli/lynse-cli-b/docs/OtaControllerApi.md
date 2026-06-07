# OtaControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**checkApkUpdate**](OtaControllerApi.md#checkApkUpdate) | **GET** /api/business/ota/app/check | 
[**checkVersion**](OtaControllerApi.md#checkVersion) | **GET** /api/business/ota/check | 
[**getFunctionList**](OtaControllerApi.md#getFunctionList) | **GET** /api/business/ota/function/list | 
[**presignUrl**](OtaControllerApi.md#presignUrl) | **GET** /api/business/ota/presign | 



## checkApkUpdate



### Example

```bash
 checkApkUpdate  platform=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **platform** | **string** |  | [default to null]

### Return type

[**ResultApkManagementVO**](ResultApkManagementVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## checkVersion



### Example

```bash
 checkVersion  platform=value  version=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **platform** | **string** |  | [default to null]
 **version** | **string** |  | [default to null]

### Return type

[**ResultOtaManagementVO**](ResultOtaManagementVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getFunctionList



### Example

```bash
 getFunctionList
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListFunctionManageVO**](ResultListFunctionManageVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## presignUrl



### Example

```bash
 presignUrl  otaId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **otaId** | **string** |  | [default to null]

### Return type

[**ResultString**](ResultString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

