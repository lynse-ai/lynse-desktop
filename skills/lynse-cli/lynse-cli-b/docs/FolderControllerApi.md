# FolderControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**add**](FolderControllerApi.md#add) | **POST** /api/business/file/folder/add | 
[**batchUpdateSort**](FolderControllerApi.md#batchUpdateSort) | **PUT** /api/business/file/folder/batch-update-sort | 
[**edit1**](FolderControllerApi.md#edit1) | **PUT** /api/business/file/folder/{folderId} | 
[**list1**](FolderControllerApi.md#list1) | **GET** /api/business/file/folder/list | 
[**selectOne**](FolderControllerApi.md#selectOne) | **GET** /api/business/file/folder/{folderId} | 



## add



### Example

```bash
 add
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **folderAddOrEditReq** | [**FolderAddOrEditReq**](FolderAddOrEditReq.md) |  |

### Return type

[**ResultString**](ResultString.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## batchUpdateSort



### Example

```bash
 batchUpdateSort
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **folderSortUpdateReq** | [**FolderSortUpdateReq**](FolderSortUpdateReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## edit1



### Example

```bash
 edit1 folderId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **folderId** | **string** |  | [default to null]
 **folderAddOrEditReq** | [**FolderAddOrEditReq**](FolderAddOrEditReq.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## list1



### Example

```bash
 list1  dto=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **dto** | [**FolderQueryReq**](.md) |  | [default to null]

### Return type

[**ResultListFolderInfoVO**](ResultListFolderInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## selectOne



### Example

```bash
 selectOne folderId=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **folderId** | **string** |  | [default to null]

### Return type

[**ResultFolderEntity**](ResultFolderEntity.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

