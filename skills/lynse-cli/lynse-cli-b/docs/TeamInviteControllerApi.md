# TeamInviteControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**createInvitation**](TeamInviteControllerApi.md#createInvitation) | **POST** /api/business/team/invite/create | 
[**handleInvite**](TeamInviteControllerApi.md#handleInvite) | **GET** /api/business/team/invite/{invitationId} | 
[**listMyInvitation**](TeamInviteControllerApi.md#listMyInvitation) | **GET** /api/business/team/invite/mine | 



## createInvitation



### Example

```bash
 createInvitation
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **generateInviteReq** | [**GenerateInviteReq**](GenerateInviteReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## handleInvite



### Example

```bash
 handleInvite invitationId=value  action=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **invitationId** | **string** |  | [default to null]
 **action** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## listMyInvitation



### Example

```bash
 listMyInvitation
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListTeamMemberInviteVO**](ResultListTeamMemberInviteVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

