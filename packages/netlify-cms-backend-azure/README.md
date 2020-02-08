# attempt to adapt netlify-cms for dev.azure.com 

WARNING - This option is currently under construction and lightyears away from complete or any PROD use

Feel welcome to contribute

### why invest into a dev.azure.com connection

netlify-cms is a smart open-source solution which already has connection to github, gitlab and bitbucket - that looks already quite well to cover a lot of use-cases - so why dev.azure.com ?

dev.azure.com in combination with the forever-free services from portal.azure.com provides a very smart enviroment for lots of projects - just one piece is missing - a smart CMS and there is no smart solution in the Azure store.

* dev.azure.com has advantages over github as you can have your repositories private for free.

* there is no need to setup and manage a serverless OAUTH-connector in AWS lambda or any identity service - just use AAD

* Azure pipelines can start building your project when commiting anything in master branch - so no need to setup TravisCI separately

* individuals will likely find everything they need in the free starter version, small-/medium companies can grow with the solution with reasonable costs - many enterprises have their entitlement already integrated so you can easily invite colleagues to your projects

* there is a full-blown project environment with tasks, stories, epics, defect/issues - sprint and backlog management, kanban boards and calenders etc giving everything to manage a website for company or similar - fully integrated to an extend that you still miss on enterprise CMS which costs a fortune - you can even define your own style of agile process - the limit is only ... how much organisation and structure do you want

* the only missing piece is a DAM (digital asset management) - but there are so many inexpensive services already out there to which you can easily connect - any thought in DIY is waste of lifetime ;-)

* dev.azure.com also allows you to handle your SSH keys secretly to you can easily use it in build pipelines to deploy your HUGO or gatsby made HTML to whereever you want (S3, CDN, your own server etc) 


## dev-test/config.yml changes needed to connect to Azure DevOps

```
backend:
  name: azure
  branch: branch-name
  project: organization-name/project-name
  repo: repo-name
  tenant_id: tenant-id
  app_id: registered-app-id  
  
site_url: "http://localhost:8080"
```
* name - just the string 'azure' to indicate the backend package and API
* branch - usually 'master' - don't change unless you know exactly what you are doing
* project - needs to be adapted from your setting, e.g. if your instance is https://dev.azure.com/coolcompany and within you have a project 'mytechblog' then it is 'coolcompany/mytechblog'
* repo - is usually also 'mytechblog' as by default, the repo has the same name as the project - but it is possible to have multiple repos in one project - in this case you might have a different name here 
* tenant_id and app_id - follow the instructions below to create an app in AAD, then add these parameters here


## general preparations

not specific to this adaption of netlify-cms to dev.azure.com

make sure you have a recent version of node/npm (I used 10.14.2) and that 'yarn' and 'lerna' are installed, too

## prepare for testing / debugging / dev for dev.azure.com

### create an app in AAD (Azure Active Directory)

In case you have 'Azure CLT' (Command Line Tools) installed you should have an 'az' command in the commandline:

```
az --version
```
will output a list of installed submodules with its version information so you know Azure Tools are installed correctly - 

please use your favorite search engine in case it isn't - where to download and how to install - and then how to prepare for its first use: 

```
az login

```
require to enter your Azure username and password - same that you use for https://portal.azure.com and https://dev.azure.com - both have forever free options as of this writing).

### create a service principal for your app
```
az ad sp create-for-rbac --name somename --password somepassword 

```

for example:
```
az ad sp create-for-rbac --name netlifycms001 --password smcyfilten 

```
please pay attention to this output - should look like this:

```
{ 
  "appId": "5d5d5d5d-eeee-4444-aaaa-ffffffffffff", 
  "displayName": "netlifycms001", 
  "name": "http://netlifycms001", 
  "password": "smcyfilten", 
  "tenant": "71717171-3333-4545-bbbb-999999999999" 
}  

```
here we find the appId and tenant_id we need for the config.yml - but hold on, we are no done yet

### change the app settings to allow creation of tokens

take your appId from above and issue this command:


```
az ad app update --id=5d5d5d5d-eeee-4444-aaaa-ffffffffffff  --oauth2-allow-implicit-flow=true --reply-urls="http://localhost:8080"
```
there is no output expected

you may want to add more reply-urls when you deploy netlify-cms to a real website - that's no problem you can have a list here - or even remove localhost:8080 if this app is not used for development (which is recommended).

### allow API usage for dev.azure.com

there is even another step required to allow that this app is allowed to make API calls to dev.azure.com API (aka VSTS API). Unfortunately I haven't found any commandline options yet - so you have to login into https://portal.azure.com, go to AAD, find your app, choose 'enterprise', and add scope: 'vso.code_full'

TODO - add screenshots here and rework description

## getting started

local testing and development (and contributing)

### get onto the latest dev

```
git clone https://github.com/chrismade/netlify-cms-backend-azure
cd netlify-cms-backend-azure
git checkout netlify-cms-backend-azure

```
please refer to 'chrismade' as long as these developments have not been merged into the netlify-master

make sure you have all required settings for your specific Azure and dev.auzre.com environment made in
```
dev-test/config.yml

```
### start the app

again: make sure you have a recent node/npm and also 'lerna' and 'yarn' installed

```
yarn --version
lerna --version

npm start

```
if everything goes well you will see a message that you can access netlify-cms at

```
http://localhost:8080

```
enter this line in Chrome and start testing (working) - Firefox may not work, see known issues

### create test objects

Since we cannot create - and persist - new objects directly you may want to create a few test objects in order to test the listing of existing objects and to jump into edit mode when you click on one of these.

Go to https://dev.azure.com/ - log in, select a project and go to 'repo'. create an empty one just containing a README.md and '.gitigore' if there isn't any content already - then create a few test files (check in your config.yml - if you have the standard 'posts' and 'faq' the path is '_posts' and '_faq'). Double check you are on the 'master' branch.

Also the filename is important and has to follow a certain scheme YYYY-MM-DD-name.md - for instance: 2019-04-10-first.md

```
---
layout: blog
title: overview.en
date: 2018-10-07T19:21:33.113Z
thumbnail: 'https://ucarecdn.com/adf1b7e6-3804-4ffa-970c-e12b055d7dff/'
categories:
- news
---
first line
second line
next line
and so on

```
Hint: The URL for the thumnail doesn't really matter - you can use anything you want

## known issues

in its current state it is easier to describe the few things that is ( / seem to be) working

### working

* start and user login, return to home screen
* list existing (pre-created) entries in collections
* click one entry from that list to open editor and find content as expected
* images in media lib of type PNG

### not yet working

* user login via Azure seems to work, a very long and sane-looking token is created but any API call returns a HTML redirect to the login screen instead of the expected json output - that is an indicator that the AAD permissions for this app are still insufficient - workround is to create a PAT (Personal Access Token) in dev.azure.com and use basic auth until the token issue is fixed
* mozilla/firefox javascript always falls into the .catch-path in function 'request' for the fetch - which is likely a header/cors issue - workaround: use chrome which doesn't show this behaviour
* writing edited objects
* create new objects/posts
* upload media objects
* editorial workflow
* delete or rename
* anything not yet explicitely mentioned as working  


...