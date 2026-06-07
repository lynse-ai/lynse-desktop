# AuthControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**bind**](AuthControllerApi.md#bind) | **GET** /api/auth/bind | 
[**exchangeToken**](AuthControllerApi.md#exchangeToken) | **POST** /api/auth/apikey/token | 
[**generateApiKey**](AuthControllerApi.md#generateApiKey) | **POST** /api/auth/apikey/generate | 
[**isLogin**](AuthControllerApi.md#isLogin) | **POST** /api/auth/isLogin | 
[**login**](AuthControllerApi.md#login) | **POST** /api/auth/login | 
[**logout**](AuthControllerApi.md#logout) | **POST** /api/auth/logout | 
[**refreshToken**](AuthControllerApi.md#refreshToken) | **POST** /api/auth/apikey/refresh | 
[**register**](AuthControllerApi.md#register) | **POST** /api/auth/register | 
[**render**](AuthControllerApi.md#render) | **GET** /api/auth/render | 
[**revokeApiKey**](AuthControllerApi.md#revokeApiKey) | **POST** /api/auth/apikey/revoke | 
[**terminate**](AuthControllerApi.md#terminate) | **POST** /api/auth/terminate | 
[**updatePhone**](AuthControllerApi.md#updatePhone) | **POST** /api/auth/updatePhone | 
[**updatePwd**](AuthControllerApi.md#updatePwd) | **POST** /api/auth/updatePwd | 
[**verifyWechatSignature**](AuthControllerApi.md#verifyWechatSignature) | **GET** /api/auth/check | 



## bind



### Example

```bash
 bind  thirdPartyId=value  username=value  captchaCode=value  authType=value  accountType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **thirdPartyId** | **string** |  | [default to null]
 **username** | **string** |  | [default to null]
 **captchaCode** | **string** |  | [default to null]
 **authType** | **string** |  | [default to null]
 **accountType** | **string** |  | [optional] [default to null]

### Return type

[**ResultAuthLoginVO**](ResultAuthLoginVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## exchangeToken



### Example

```bash
 exchangeToken X-API-Key:value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **xAPIKey** | **string** |  | [default to null]

### Return type

[**ResultApiTokenPairVO**](ResultApiTokenPairVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## generateApiKey



### Example

```bash
 generateApiKey
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultApiKeyGenerateVO**](ResultApiKeyGenerateVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## isLogin



### Example

```bash
 isLogin
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


## login



### Example

```bash
 login
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **authLoginReq** | [**AuthLoginReq**](AuthLoginReq.md) |  |

### Return type

[**ResultAuthLoginVO**](ResultAuthLoginVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## logout



### Example

```bash
 logout
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


## refreshToken



### Example

```bash
 refreshToken
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **apiTokenRefreshReq** | [**ApiTokenRefreshReq**](ApiTokenRefreshReq.md) |  |

### Return type

[**ResultApiTokenPairVO**](ResultApiTokenPairVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## register



### Example

```bash
 register
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **authRegisterReq** | [**AuthRegisterReq**](AuthRegisterReq.md) |  |

### Return type

[**ResultString**](ResultString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## render



### Example

```bash
 render  authType=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **authType** | **string** |  | [default to null]

### Return type

[**ResultString**](ResultString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## revokeApiKey



### Example

```bash
 revokeApiKey
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


## terminate



### Example

```bash
 terminate
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


## updatePhone



### Example

```bash
 updatePhone
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **authUpdatePhoneReq** | [**AuthUpdatePhoneReq**](AuthUpdatePhoneReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## updatePwd



### Example

```bash
 updatePwd
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **authUpdateReq** | [**AuthUpdateReq**](AuthUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## verifyWechatSignature



### Example

```bash
 verifyWechatSignature  signature=value  timestamp=value  nonce=value  echostr=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **signature** | **string** |  | [default to null]
 **timestamp** | **string** |  | [default to null]
 **nonce** | **string** |  | [default to null]
 **echostr** | **string** |  | [default to null]

### Return type

**string**

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

