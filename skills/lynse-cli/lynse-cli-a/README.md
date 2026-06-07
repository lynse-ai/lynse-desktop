# OpenAPI definition Bash client

## Overview

This is a Bash client script for accessing OpenAPI definition service.

The script uses cURL underneath for making all REST calls.

## Usage

```shell
# Make sure the script has executable rights
$ chmod u+x 

# Print the list of operations available on the service
$ ./ -h

# Print the service description
$ ./ --about

# Print detailed information about specific operation
$ ./ <operationId> -h

# Make GET request
./ --host http://<hostname>:<port> --accept xml <operationId> <queryParam1>=<value1> <header_key1>:<header_value2>

# Make GET request using arbitrary curl options (must be passed before <operationId>) to an SSL service using username:password
 -k -sS --tlsv1.2 --host https://<hostname> -u <user>:<password> --accept xml <operationId> <queryParam1>=<value1> <header_key1>:<header_value2>

# Make POST request
$ echo '<body_content>' |  --host <hostname> --content-type json <operationId> -

# Make POST request with simple JSON content, e.g.:
# {
#   "key1": "value1",
#   "key2": "value2",
#   "key3": 23
# }
$ echo '<body_content>' |  --host <hostname> --content-type json <operationId> key1==value1 key2=value2 key3:=23 -

# Make POST request with form data
$  --host <hostname> <operationId> key1:=value1 key2:=value2 key3:=23

# Preview the cURL command without actually executing it
$  --host http://<hostname>:<port> --dry-run <operationid>

```

## Docker image

You can easily create a Docker image containing a preconfigured environment
for using the REST Bash client including working autocompletion and short
welcome message with basic instructions, using the generated Dockerfile:

```shell
docker build -t my-rest-client .
docker run -it my-rest-client
```

By default you will be logged into a Zsh environment which has much more
advanced auto completion, but you can switch to Bash, where basic autocompletion
is also available.

## Shell completion

### Bash

The generated bash-completion script can be either directly loaded to the current Bash session using:

```shell
source .bash-completion
```

Alternatively, the script can be copied to the `/etc/bash-completion.d` (or on OSX with Homebrew to `/usr/local/etc/bash-completion.d`):

```shell
sudo cp .bash-completion /etc/bash-completion.d/
```

#### OS X

On OSX you might need to install bash-completion using Homebrew:

```shell
brew install bash-completion
```

and add the following to the `~/.bashrc`:

```shell
if [ -f $(brew --prefix)/etc/bash_completion ]; then
  . $(brew --prefix)/etc/bash_completion
fi
```

### Zsh

In Zsh, the generated `_` Zsh completion file must be copied to one of the folders under `$FPATH` variable.

## Documentation for API Endpoints

All URIs are relative to **

Class | Method | HTTP request | Description
------------ | ------------- | ------------- | -------------
*AuthControllerApi* | [**bind**](docs/AuthControllerApi.md#bind) | **GET** /api/auth/bind | 
*AuthControllerApi* | [**exchangeToken**](docs/AuthControllerApi.md#exchangetoken) | **POST** /api/auth/apikey/token | 
*AuthControllerApi* | [**generateApiKey**](docs/AuthControllerApi.md#generateapikey) | **POST** /api/auth/apikey/generate | 
*AuthControllerApi* | [**isLogin**](docs/AuthControllerApi.md#islogin) | **POST** /api/auth/isLogin | 
*AuthControllerApi* | [**login**](docs/AuthControllerApi.md#login) | **POST** /api/auth/login | 
*AuthControllerApi* | [**logout**](docs/AuthControllerApi.md#logout) | **POST** /api/auth/logout | 
*AuthControllerApi* | [**refreshToken**](docs/AuthControllerApi.md#refreshtoken) | **POST** /api/auth/apikey/refresh | 
*AuthControllerApi* | [**register**](docs/AuthControllerApi.md#register) | **POST** /api/auth/register | 
*AuthControllerApi* | [**render**](docs/AuthControllerApi.md#render) | **GET** /api/auth/render | 
*AuthControllerApi* | [**revokeApiKey**](docs/AuthControllerApi.md#revokeapikey) | **POST** /api/auth/apikey/revoke | 
*AuthControllerApi* | [**terminate**](docs/AuthControllerApi.md#terminate) | **POST** /api/auth/terminate | 
*AuthControllerApi* | [**updatePhone**](docs/AuthControllerApi.md#updatephone) | **POST** /api/auth/updatePhone | 
*AuthControllerApi* | [**updatePwd**](docs/AuthControllerApi.md#updatepwd) | **POST** /api/auth/updatePwd | 
*AuthControllerApi* | [**verifyWechatSignature**](docs/AuthControllerApi.md#verifywechatsignature) | **GET** /api/auth/check | 
*AuthPoolControllerApi* | [**getPoolStatus**](docs/AuthPoolControllerApi.md#getpoolstatus) | **GET** /api/auth/pool/status | 
*MessageControllerApi* | [**emailCode**](docs/MessageControllerApi.md#emailcode) | **GET** /api/auth/captcha/email | 
*MessageControllerApi* | [**smsCode**](docs/MessageControllerApi.md#smscode) | **GET** /api/auth/captcha/sms | 


## Documentation For Models

 - [ApiKeyGenerateVO](docs/ApiKeyGenerateVO.md)
 - [ApiTokenPairVO](docs/ApiTokenPairVO.md)
 - [ApiTokenRefreshReq](docs/ApiTokenRefreshReq.md)
 - [AuthLoginReq](docs/AuthLoginReq.md)
 - [AuthLoginVO](docs/AuthLoginVO.md)
 - [AuthRegisterReq](docs/AuthRegisterReq.md)
 - [AuthUpdatePhoneReq](docs/AuthUpdatePhoneReq.md)
 - [AuthUpdateReq](docs/AuthUpdateReq.md)
 - [ResultApiKeyGenerateVO](docs/ResultApiKeyGenerateVO.md)
 - [ResultApiTokenPairVO](docs/ResultApiTokenPairVO.md)
 - [ResultAuthLoginVO](docs/ResultAuthLoginVO.md)
 - [ResultBoolean](docs/ResultBoolean.md)
 - [ResultSmsCodeVO](docs/ResultSmsCodeVO.md)
 - [ResultString](docs/ResultString.md)
 - [SmsCodeVO](docs/SmsCodeVO.md)


## Documentation For Authorization

 All endpoints do not require authorization.

