# TeamFileControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**editTeamFile**](TeamFileControllerApi.md#editTeamFile) | **PUT** /api/business/team/file/{fileId} | 
[**getFileInfo**](TeamFileControllerApi.md#getFileInfo) | **GET** /api/business/team/file/info | 
[**listTeamFile**](TeamFileControllerApi.md#listTeamFile) | **GET** /api/business/team/file/list | 
[**moveOrCopy**](TeamFileControllerApi.md#moveOrCopy) | **POST** /api/business/team/file/share | 
[**removeTeamFile**](TeamFileControllerApi.md#removeTeamFile) | **DELETE** /api/business/team/file/remove | 



## editTeamFile



### Example

```bash
 editTeamFile fileId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]
 **teamFileUpdateReq** | [**TeamFileUpdateReq**](TeamFileUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## getFileInfo



### Example

```bash
 getFileInfo  fileId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileId** | **string** |  | [default to null]

### Return type

[**ResultTeamFileInfoVO**](ResultTeamFileInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## listTeamFile



### Example

```bash
 listTeamFile  teamId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamId** | **string** |  | [default to null]

### Return type

[**ResultListTeamFileInfoVO**](ResultListTeamFileInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## moveOrCopy



### Example

```bash
 moveOrCopy
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **teamFileAddReq** | [**TeamFileAddReq**](TeamFileAddReq.md) |  |

### Return type

[**ResultListFileActionVO**](ResultListFileActionVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## removeTeamFile



### Example

```bash
 removeTeamFile  Specify as:  fileIds=value1 fileIds=value2 fileIds=...  teamId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **fileIds** | [**array[string]**](string.md) |  | [default to null]
 **teamId** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

