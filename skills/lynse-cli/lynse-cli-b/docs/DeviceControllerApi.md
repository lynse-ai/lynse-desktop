# DeviceControllerApi

All URIs are relative to **

Method | HTTP request | Description
------------- | ------------- | -------------
[**bind**](DeviceControllerApi.md#bind) | **POST** /api/business/device/bind | 
[**isBound**](DeviceControllerApi.md#isBound) | **GET** /api/business/device/isBound | 
[**listMyBindingDeviceList**](DeviceControllerApi.md#listMyBindingDeviceList) | **GET** /api/business/device/mine | 
[**unbind**](DeviceControllerApi.md#unbind) | **GET** /api/business/device/unbind | 
[**update**](DeviceControllerApi.md#update) | **PUT** /api/business/device/update | 
[**updateConnectTime**](DeviceControllerApi.md#updateConnectTime) | **PUT** /api/business/device/updateConnectTime | 



## bind



### Example

```bash
 bind
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **deviceBindVO** | [**DeviceBindVO**](DeviceBindVO.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## isBound



### Example

```bash
 isBound  Specify as:  macAddressList=value1 macAddressList=value2 macAddressList=...
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **macAddressList** | [**array[string]**](string.md) |  | [default to null]

### Return type

[**ResultListDeviceBindingStatusVO**](ResultListDeviceBindingStatusVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## listMyBindingDeviceList



### Example

```bash
 listMyBindingDeviceList
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**ResultListDeviceInfoVO**](ResultListDeviceInfoVO.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## unbind



### Example

```bash
 unbind  macAddress=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **macAddress** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## update



### Example

```bash
 update
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **deviceUpdateDTO** | [**DeviceUpdateDTO**](DeviceUpdateDTO.md) |  |

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)


## updateConnectTime



### Example

```bash
 updateConnectTime  macAddress=value
```

### Parameters


Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **macAddress** | **string** |  | [default to null]

### Return type

[**ResultBoolean**](ResultBoolean.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not Applicable
- **Accept**: */*

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

