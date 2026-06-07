# CustomerControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**changeTeam**](CustomerControllerApi.md#changeTeam) | **GET** /api/business/customer/changeTeam | 
[**current**](CustomerControllerApi.md#current) | **GET** /api/business/customer/current | 
[**detail**](CustomerControllerApi.md#detail) | **GET** /api/business/customer/detail | 
[**edit2**](CustomerControllerApi.md#edit2) | **PUT** /api/business/customer | 
[**edit3**](CustomerControllerApi.md#edit3) | **PUT** /api/business/customer/{customerId} | 
[**grantDurationPackage**](CustomerControllerApi.md#grantDurationPackage) | **POST** /api/business/customer/membership/package/grant | 
[**grantMonthlyReward**](CustomerControllerApi.md#grantMonthlyReward) | **GET** /api/business/customer/bonus | 
[**grantTeamUpgrade**](CustomerControllerApi.md#grantTeamUpgrade) | **GET** /api/business/customer/grantTeamUpgrade | 
[**list2**](CustomerControllerApi.md#list2) | **GET** /api/business/customer/list | 
[**outPutLanguage**](CustomerControllerApi.md#outPutLanguage) | **PUT** /api/business/customer/outPutLanguage | 
[**recharge1**](CustomerControllerApi.md#recharge1) | **POST** /api/business/customer/recharge | 
[**rechargeMembership**](CustomerControllerApi.md#rechargeMembership) | **POST** /api/business/customer/membership/recharge | 
[**refreshMembershipQuota**](CustomerControllerApi.md#refreshMembershipQuota) | **GET** /api/business/customer/membership/refresh | 
[**register**](CustomerControllerApi.md#register) | **POST** /api/business/customer/register | 
[**syncMembership**](CustomerControllerApi.md#syncMembership) | **POST** /api/business/customer/membership/sync | 
[**terminate**](CustomerControllerApi.md#terminate) | **DELETE** /api/business/customer | 
[**updatePwd**](CustomerControllerApi.md#updatePwd) | **PUT** /api/business/customer/updatePwd | 



## changeTeam



### Example

```bash
 changeTeam  teamId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamId** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## current



### Example

```bash
 current
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultCustomerInfoVO**](ResultCustomerInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## detail



### Example

```bash
 detail  queryReq=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **queryReq** | [**CustomerQueryReq**](.md) |  | [default to null]

### Return type

[**ResultCustomerExtInfoVO**](ResultCustomerExtInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## edit2



### Example

```bash
 edit2
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **customerUpdateReq** | [**CustomerUpdateReq**](CustomerUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## edit3



### Example

```bash
 edit3 customerId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **customerId** | **string** |  | [default to null]
 **customerUpdateReq** | [**CustomerUpdateReq**](CustomerUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## grantDurationPackage



### Example

```bash
 grantDurationPackage
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **customerDurationPackageGrantReq** | [**CustomerDurationPackageGrantReq**](CustomerDurationPackageGrantReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## grantMonthlyReward



### Example

```bash
 grantMonthlyReward
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultBonusVO**](ResultBonusVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## grantTeamUpgrade



### Example

```bash
 grantTeamUpgrade
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


## list2



### Example

```bash
 list2  queryReq=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **queryReq** | [**CustomerQueryReq**](.md) |  | [default to null]

### Return type

[**ResultListCustomerInfoVO**](ResultListCustomerInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## outPutLanguage



### Example

```bash
 outPutLanguage  language=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **language** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## recharge1



### Example

```bash
 recharge1
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **customerRechargeReq** | [**CustomerRechargeReq**](CustomerRechargeReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## rechargeMembership



### Example

```bash
 rechargeMembership
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **customerMembershipRechargeReq** | [**CustomerMembershipRechargeReq**](CustomerMembershipRechargeReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## refreshMembershipQuota



### Example

```bash
 refreshMembershipQuota
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultCustomerMembershipQuotaVO**](ResultCustomerMembershipQuotaVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
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
 **customerRegisterReq** | [**CustomerRegisterReq**](CustomerRegisterReq.md) |  |

### Return type

[**ResultString**](ResultString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## syncMembership



### Example

```bash
 syncMembership
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **customerMembershipSyncReq** | [**CustomerMembershipSyncReq**](CustomerMembershipSyncReq.md) |  |

### Return type

[**ResultCustomerMembershipQuotaVO**](ResultCustomerMembershipQuotaVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## terminate



### Example

```bash
 terminate  customerId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **customerId** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
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
 **customerUpdateReq** | [**CustomerUpdateReq**](CustomerUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

