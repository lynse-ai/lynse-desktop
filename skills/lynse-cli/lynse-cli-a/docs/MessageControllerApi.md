# MessageControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**emailCode**](MessageControllerApi.md#emailCode) | **GET** /api/auth/captcha/email | 
[**smsCode**](MessageControllerApi.md#smsCode) | **GET** /api/auth/captcha/sms | 



## emailCode



### Example

```bash
 emailCode  email=value  actionType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **email** | **string** |  | [default to null]
 **actionType** | **string** |  | [default to null]

### Return type

[**ResultSmsCodeVO**](ResultSmsCodeVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## smsCode



### Example

```bash
 smsCode  phone=value  actionType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **phone** | **string** |  | [default to null]
 **actionType** | **string** |  | [default to null]

### Return type

[**ResultSmsCodeVO**](ResultSmsCodeVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

