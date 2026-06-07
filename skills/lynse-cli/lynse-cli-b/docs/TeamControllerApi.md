# TeamControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**allocatePointsToTeam**](TeamControllerApi.md#allocatePointsToTeam) | **POST** /api/business/team/points/allocate | 
[**assignRole**](TeamControllerApi.md#assignRole) | **GET** /api/business/team/member/assign | 
[**checkTeamAdminOrOwner**](TeamControllerApi.md#checkTeamAdminOrOwner) | **GET** /api/business/team/checkAdmin | 
[**createTeam**](TeamControllerApi.md#createTeam) | **POST** /api/business/team/create | 
[**deleteTeam**](TeamControllerApi.md#deleteTeam) | **DELETE** /api/business/team/{teamId} | 
[**editTeam**](TeamControllerApi.md#editTeam) | **PUT** /api/business/team/{teamId} | 
[**info**](TeamControllerApi.md#info) | **GET** /api/business/team/{teamId} | 
[**leaveTeam**](TeamControllerApi.md#leaveTeam) | **GET** /api/business/team/leave | 
[**listMyTeam**](TeamControllerApi.md#listMyTeam) | **GET** /api/business/team | 
[**recharge**](TeamControllerApi.md#recharge) | **POST** /api/business/team/recharge | 
[**removeTeamMember**](TeamControllerApi.md#removeTeamMember) | **GET** /api/business/team/member/remove | 



## allocatePointsToTeam



### Example

```bash
 allocatePointsToTeam  pointsAmount=value  teamId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **pointsAmount** | **integer** |  | [default to null]
 **teamId** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## assignRole



### Example

```bash
 assignRole  teamId=value  role=value  memberInfoId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamId** | **string** |  | [default to null]
 **role** | **integer** |  | [default to null]
 **memberInfoId** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## checkTeamAdminOrOwner



### Example

```bash
 checkTeamAdminOrOwner  customerId=value  teamId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **customerId** | **string** |  | [default to null]
 **teamId** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## createTeam



### Example

```bash
 createTeam
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamAddOrEditReq** | [**TeamAddOrEditReq**](TeamAddOrEditReq.md) |  |

### Return type

[**ResultString**](ResultString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## deleteTeam



### Example

```bash
 deleteTeam teamId=value
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


## editTeam



### Example

```bash
 editTeam teamId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamId** | **string** |  | [default to null]
 **teamAddOrEditReq** | [**TeamAddOrEditReq**](TeamAddOrEditReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## info



### Example

```bash
 info teamId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamId** | **string** |  | [default to null]

### Return type

[**ResultTeamInfoVO**](ResultTeamInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## leaveTeam



### Example

```bash
 leaveTeam  teamId=value
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


## listMyTeam



### Example

```bash
 listMyTeam
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListTeamInfoVO**](ResultListTeamInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## recharge



### Example

```bash
 recharge
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamRechargeReq** | [**TeamRechargeReq**](TeamRechargeReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## removeTeamMember



### Example

```bash
 removeTeamMember  teamId=value  memberInfoId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamId** | **string** |  | [default to null]
 **memberInfoId** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

