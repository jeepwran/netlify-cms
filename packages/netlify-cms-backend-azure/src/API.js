import { Base64 } from 'js-base64';
import { uniq, initial, last, get, find, hasIn, partial, result } from 'lodash';
import {
  localForage,
  filterPromises,
  resolvePromiseProperties,
  APIError,
  EditorialWorkflowError,
} from 'netlify-cms-lib-util';

const CMS_BRANCH_PREFIX = 'cms/';

// from here you can navigate trees, looking for blobs
// https://dev.azure.com/{tenant}/{project}/_apis/git/repositories/{repo}/items?path=/&version={branch}&api-version=5.0

// or to specify known folder
// https://dev.azure.com/{tenant}/{project}/_apis/git/repositories/{repo}}/items?path={path}&version=[branch]&api-version=5.0

// or to specify recursionLevel (WTF that does all options return same json, no recusion into scopePath, on my repo)
// https://dev.azure.com/{tenant}/{project}/_apis/git/repositories/{repo}}/items?scopePath=/content&recursionLevel=oneLevel&version=[branch]&api-version=5.0

export default class API {
  constructor(config) {
    this.api_root = (config.api_root || 'https://dev.azure.com') + `/${config.project}/_apis/git/repositories/`;
    this.token = config.token || false;
    this.branch = config.branch || 'master';
    this.repo = config.repo || '';
    this.repoURL = `${this.repo}`;
    this.merge_method = config.squash_merges ? 'squash' : 'merge';
    this.initialWorkflowStatus = config.initialWorkflowStatus;
    this.apiversion = '5.0'; // Azure API version is recommended and sometimes even required
  }

  requestHeaders(headers = {}) {
    const baseHeader = {
      'Content-Type': 'application/json',
	    'Access-Control-Allow-Origin' : '*', // Azure response header requires this
	    'Origin': '*', 
      ...headers,
    };

    if (this.token) {
      baseHeader.Authorization = `token ${this.token}`;
      // workaround - until token is working as expected and returns expected json instead of non-auth info in html to API calls
      // create a PAT = personal access token in dev.azure and use that as password
      // see https://majgis.github.io/2017/09/13/Create-Authorization-Basic-Header/ how to create base64 string for basic auth
      // or in FF/Chrom-console > btoa('username@something.com:thisIsMyVeryLongPersonalAccessToken')
      // baseHeader.Authorization = 'Basic Y--generate-your-own-auth-string-with-username-and-personal-access-token-base64-encoded-Q==';
      baseHeader.Authorization = 'Basic Y2hyaXN0b3BoLm1huuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuwcQ==';
    	// console.log('** DEBUG azure' +  baseHeader.Authorization );
      return baseHeader;
    }

    return baseHeader;
  }

  parseJsonResponse(response) {
    return response.json().then(json => {
      if (!response.ok) {
        return Promise.reject(json);
      }

      return json;
    });
  }

  urlFor(path, options) {
    const cacheBuster = new Date().getTime();
    const params = [`ts=${cacheBuster}&api-version=${this.apiversion}`]; // added Azure specific api-version
    let pathext;
    if (options.params) {
      for (const key in options.params) {
        params.push(`${key}=${encodeURIComponent(options.params[key])}`);
      }
    }
    if (params.length) {
      pathext = `${params.join('&')}`;
    }
    if (path.startsWith('https')) { // Azure specific - path may already be a fully qualified URL 
      path +=  `?${pathext}`; // assume we have already one divider '?'
    } else {
      path = this.api_root + path +  `?${pathext}`;
    }
    console.log('** DEBUG azure urlFor  -- path = ' + path + ' -- options: ' + JSON.stringify( options )  );
    return path;
    // return this.api_root + path;
    }

  request(path, options = {}) {
    const headers = this.requestHeaders(options.headers || {});
    console.log('**DEBUG entering req path: ' + path +   ' -- options: ' + JSON.stringify( options ) );
    const url = this.urlFor(path, options);
	  options.mode = 'cors'; // Azure ensure headers are set to get suitable response
    let responseStatus;
    return fetch(url, { ...options, headers })
      .then(response => {
        responseStatus = response.status;
        const contentType = response.headers.get('Content-Type');
        if (contentType && contentType.match(/json/)) {
          return this.parseJsonResponse(response);
        }
        const text = response.text();
        console.log('**DEBUG hm, req response was text not json: ' + JSON.stringify( text ) );
        if (!response.ok) {
          return Promise.reject(text);
        }
        return text;
      })
      .catch(error => {
        console.log('**DEBUG: request catch ' + url + error.message + responseStatus);
        throw new APIError(error.message, responseStatus, 'Azure');
      });
  }

  generateBranchName(basename) {
    return `${CMS_BRANCH_PREFIX}${basename}`;
  }

  checkMetadataRef() {
    console.log('** DEBUG entering  checkMetadataRef');
    // return this.request(`${this.repoURL}/git/refs/meta/_netlify_cms?${Date.now()}`, { // TODO: rework for Azure
    return this.request(`${this.repoURL}/refs?ts=${Date.now()}`, { // Azure
      params: { filter: 'heads/meta/_netlify_cms' },
      // params: { filter: 'heads/cms/2019-05-29-neu102mai' },
      cache: 'no-store',
    })
    // .then(response => response.object)
    .then(response => {
      if (  response.count  > 0 ) {
        console.log('** DEBUG return /refs:' + JSON.stringify(response));
      } else {
        console.log('** DEBUG return /refs: empty set' );
        const readme = {
          raw:
            '# Netlify CMS\n\nThis tree is used by the Netlify CMS to store metadata information for specific files and branches. DONT TOUCH unless you know exactly what you are doing!!',
        };
        console.log('** DEBUG inside checkMetadataRef - we dont have meta/_netlify_cms - create it now')
          return this.uploadBlobAzure({
             path: '/readme.md',
             raw: readme,
             file: true,
          }, 'initial create of meta/_netlify_cms', 'meta/_netlify_cms')
         .then ( response => {
            console.log ('** DEBUG DEBUG inside checkMetadataRef after creating meta/_netlify_cms: ' + JSON.stringify(response));
            return response;
         } );
        }
      })
  }

  storeMetadata(key, data) {
    console.log ('** DEBUG entering storeMetadata --  key: '+ key + ' -- data: ' + JSON.stringify(data)  );
    return this.checkMetadataRef().then(branchData => {
      const fileTree = {
        [`${key}.json`]: {
          path: `${key}.json`,
          raw: JSON.stringify(data),
          file: true,
        },
      };
      console.log ('** DEBUG inside storeMetadata --  fileTree: '+  JSON.stringify(fileTree)  );
      console.log ('** DEBUG inside storeMetadata --  key: '+ key + ' -- data: ' + JSON.stringify(data)  );
      console.log ('**** DEBUG inside storeMetadata --  branchData: '+  JSON.stringify( branchData ) );
      return this.uploadBlobAzure(fileTree[`${key}.json`], `Updating “${key}” metadata`, 'meta/_netlify_cms')
        //.then(() => this.updateTree(branchData.sha, '/', fileTree))
        .then(changeTree => console.log ('**** DEBUG inside storeMetadata --  changeTree: ' + JSON.stringify(changeTree) ) )
        // this.commit(`Updating “${key}” metadata`, changeTree);
        // .then(response => this.patchRef('meta', '_netlify_cms', response.sha))
        .then(() => {
          localForage.setItem(`gh.meta.${key}`, {
            expires: Date.now() + 300000, // In 5 minutes
            data,
          });
        });
    });
  }

  retrieveMetadata(key) {
    const cache = localForage.getItem(`gh.meta.${key}`);
    console.log ('** DEBUG retrieveMetadata --  key: '+ `gh.meta.${key}` );
    return cache.then(cached => {
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }
      console.log(
        '%c Checking for MetaData files',
        'line-height: 30px;text-align: center;font-weight: bold',
      );
      return this.request(`${this.repoURL}/items`, {
        // params: { version: 'refs/meta/_netlify_cms', path: `${key}.json` },
        params: { version: 'meta/_netlify_cms', path: `${key}.json` },
        headers: { Accept: 'application/vnd.github.VERSION.raw' },
        cache: 'no-store',
      })
        .then(response => JSON.parse(response))
        .catch(() =>
          console.log(
            '%c %s does not have metadata',
            'line-height: 30px;text-align: center;font-weight: bold',
            key,
          ),
        );
    });
  }

  readFile(path, sha, branch = this.branch) {
    if (sha) {
      return this.getBlob(sha, path); // Azure if we have ObjId = sha then we usually already have an URL, too
    } else {
      return this.request(`${this.repoURL}/items/${path}`, {
        headers: { Accept: 'application/vnd.github.VERSION.raw' },
        // params: { ref: branch },
        params: { version: branch },
        cache: 'no-store',
      }).catch(error => { // Azure - not sure if we will ever get beyond this point
        if (hasIn(error, 'message.errors') && find(error.message.errors, { code: 'too_large' })) {
          const dir = path
            .split('/')
            .slice(0, -1)
            .join('/');
          return this.listFiles(dir)
            .then(files => files.find(file => file.path === path))
            .then(file => this.getBlob(file.sha));
        }
        throw error;
      });
    }
  }

  getBlob(sha, url) { // In Azure we don't have the ObjectId = sha handy always - caution !
    console.log ('** DEBUG entering getBlob: sha: ' + sha + ' -- url: ' + url );
    // Azure - disable caching as long as we cannot ensure a valid ObjId = sha always
    // return localForage.getItem(`gh.${sha}`).then(cached => {
    //  if (cached) {
    //    return cached;
    //  }

      // return this.request(`${this.repoURL}/git/blobs/${sha}`, {
        return this.request(`${url}`, { // Azure
          headers: { Accept: 'application/vnd.github.VERSION.raw' },
      }).then(result => {
        localForage.setItem(`gh.${sha}`, result);
        return result;
      });
    // });
  }

  listFiles(path) {
    console.log ('** DEBUG entering listFiles: path: ' ); 
    // return this.request(`${this.repoURL}/contents/${path.replace(/\/$/, '')}`, {
    return this.request(`${this.repoURL}/items/`, { // Azure
        // params: { ref: this.branch },
      params: { version: this.branch, path: path }, // Azure
    }).then(response => {
      console.log('**DEBUG: getTreeId -- returnObj: ' + JSON.stringify(response) )
        return response._links.tree.href 
      })
      .then ( url => {
         console.log('**DEBUG: list files  -- url: ' + url )
        return this.request(`${url}`);
      })
      .then(response => {
        const files = ( response.treeEntries || [ ]);
        console.log('** DEBUG - treeEntries ' + JSON.stringify(files) );
        if (!Array.isArray(files)) {
          throw new Error(`Cannot list files, path ${path} is not a directory but a ${files.type}`);
        }
        return files;
      })
      // .then(files => files.filter(file => file.type === 'file'));
      .then(files => files.filter(file => file.gitObjectType === 'blob'));    // Azure
  }

  readUnpublishedBranchFile(contentKey) {
    const metaDataPromise = this.retrieveMetadata(contentKey).then(data =>
      data.objects.entry.path ? data : Promise.reject(null),
    );
    return resolvePromiseProperties({
      metaData: metaDataPromise,
      fileData: metaDataPromise.then(data =>
        this.readFile(data.objects.entry.path, null, data.branch),
      ),
      isModification: metaDataPromise.then(data =>
        this.isUnpublishedEntryModification(data.objects.entry.path, this.branch),
      ),
    }).catch(() => {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    });
  }

  isUnpublishedEntryModification(path, branch) {
    return this.readFile(path, null, branch)
      .then(() => true)
      .catch(err => {
        if (err.message && err.message === 'Not Found') {
          return false;
        }
        throw err;
      });
  }

  listUnpublishedBranches() {
    console.log(
      '%c Checking for Unpublished entries',
      'line-height: 30px;text-align: center;font-weight: bold',
    );
    return this.request(`${this.repoURL}/git/refs/heads/cms`)
      .then(branches =>
        filterPromises(branches, branch => {
          const branchName = branch.ref.substring('/refs/heads/'.length - 1);

          // Get PRs with a `head` of `branchName`. Note that this is a
          // substring match, so we need to check that the `head.ref` of
          // at least one of the returned objects matches `branchName`.
          return this.request(`${this.repoURL}/pulls`, {
            params: {
              head: branchName,
              state: 'open',
              base: this.branch,
            },
          }).then(prs => prs.some(pr => pr.head.ref === branchName));
        }),
      )
      .catch(error => {
        console.log(
          '%c No Unpublished entries',
          'line-height: 30px;text-align: center;font-weight: bold',
        );
        throw error;
      });
  }

  /**
   * Retrieve statuses for a given SHA. Unrelated to the editorial workflow
   * concept of entry "status". Useful for things like deploy preview links.
   */
  async getStatuses(sha) {
    // const resp = await this.request(`${this.repoURL}/commits/${sha}/status`); // github
    const resp = await this.request(`${this.repoURL}/commits/${sha}`); // Azure
    // return resp.statuses;
    return [];
  }

  composeFileTree(files) {
    console.log ('** DEBUG entering composeFileTree - files: ' + JSON.stringify (files) );
    let filename;
    let part;
    let parts;
    let subtree;
    const fileTree = {};

    files.forEach(file => {
      if (file.uploaded) {
        return;
      }
      parts = file.path.split('/').filter(part => part);
      filename = parts.pop();
      subtree = fileTree;
      while ((part = parts.shift())) {
        // eslint-disable-line no-cond-assign
        subtree[part] = subtree[part] || {};
        subtree = subtree[part];
      }
      subtree[filename] = file;
      file.file = true;
    });

    return fileTree;
  }

  persistFiles(entry, mediaFiles, options) {
    console.log ('** DEBUG entering persistFiles - entry: ' + JSON.stringify(entry) + ' -- mediafiles: ' + mediaFiles + ' -- options: ' + JSON.stringify(options) );
    const uploadPromises = [];
    const files = entry ? mediaFiles.concat(entry) : mediaFiles;

    files.forEach(file => {
      if (file.uploaded) {
        return;
      }
      uploadPromises.push(this.uploadBlobAzure(file, options.commitMessage ));
    });

    const fileTree = this.composeFileTree(files); 
    console.log('*** DEBUG inside persistFiles - fileTree: ' + JSON.stringify(fileTree) );

    /// return Promise.all(uploadPromises);
    // this block req rework in Azure
    return Promise.all(uploadPromises).then(() => {
      console.log('*** DEBUG inside persistFiles - Promise.all: uploadPromises: ' + JSON.stringify(uploadPromises)  );
      if (!options.useWorkflow) {
        return this.getBranch()
        //    .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
        .then(branchData => console.log('*** DEBUG inside persistFiles - branchData: ' + JSON.stringify(branchData)))
        //    .then(changeTree => this.commit(options.commitMessage, changeTree))
        .then(response => this.patchBranch(this.branch, response.sha));
        } else {
         const mediaFilesList = mediaFiles.map(file => ({ path: file.path, sha: file.sha }));
         console.log('*** DEBUG inside persistFiles - else - file : ' );
         return this.editorialWorkflowGit(fileTree, entry, mediaFilesList, options);
      }
      });
  }

  deleteFile(path, message, options = {}) {
    console.log ('** DEBUG entering deleteFile - path: ' + path + ' --message: ' + message + ' -- options: ' + options);
    const branch = options.branch || this.branch;
    const pathArray = path.split('/');
    const filename = last(pathArray);
    const directory = initial(pathArray).join('/');
    const fileDataPath = encodeURIComponent(directory);
    const fileDataURL = `${this.repoURL}/git/trees/${branch}:${fileDataPath}`;
    const fileURL = `${this.repoURL}/contents/${path}`;

    /**
     * We need to request the tree first to get the SHA. We use extended SHA-1
     * syntax (<rev>:<path>) to get a blob from a tree without having to recurse
     * through the tree.
     */
    return this.request(fileDataURL, { cache: 'no-store' }).then(resp => {
      const { sha } = resp.tree.find(file => file.path === filename);
      const opts = { method: 'DELETE', params: { sha, message, branch } };
      if (this.commitAuthor) {
        opts.params.author = {
          ...this.commitAuthor,
          date: new Date().toISOString(),
        };
      }
      return this.request(fileURL, opts);
    });
  }

  editorialWorkflowGit(fileTree, entry, filesList, options) {
    console.log ('** DEBUG entering editorialWorkflowGit -  fileTree: ' + JSON.stringify (fileTree) + ' --entry: '+ JSON.stringify (entry ));
    const contentKey = entry.slug;
    const branchName = this.generateBranchName(contentKey);
    const unpublished = options.unpublished || false;
    if (!unpublished) {
      // Open new editorial review workflow for this entry - Create new metadata and commit to new branch`
      console.log ('** DEBUG inside editorialWorkflowGit -  Create new metadata and commit to new branch '  );
      let prResponse;

      // return this.getBranch()
        // .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
        // .then(changeTree => this.commit(options.commitMessage, changeTree))
        // .then(commitResponse => this.createBranch(branchName, commitResponse.sha))
        // .then(() => this.createPR(options.commitMessage, branchName))
        // .then(pr => {
        //  prResponse = pr;
        //  return this.user();
        // })
        // .then(user => {
          return this.storeMetadata(contentKey, {
            type: 'PR',
            pr: {
              number: 'prResponse.number',
        //      head: 'prResponse.head && prResponse.head.sha',
              head: '4f9035742b11fef32efcc8e226b60866597dfca4',
            },
            user: 'user.name || user.login',
            status: this.initialWorkflowStatus,
            branch: branchName,
            collection: options.collectionName,
            title: options.parsedData && options.parsedData.title,
            description: options.parsedData && options.parsedData.description,
            objects: {
              entry: {
                path: entry.path,
                sha: 'entry.sha',
              },
              files: filesList,
            },
            timeStamp: new Date().toISOString(),
          });
        // });
    } else {
      // Entry is already on editorial review workflow - just update metadata and commit to existing branch
      let newHead;
      console.log ('** DEBUG inside editorialWorkflowGit -  just update metadata and commit to existing branch'  );
      // return this.getBranch(branchName)
      //  .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
      //  .then(changeTree => this.commit(options.commitMessage, changeTree))
      //  .then(commit => {
      //    newHead = commit;
      //    return this.retrieveMetadata(contentKey);
      //  })
        return this.retrieveMetadata(contentKey)
        .then(metadata => {
          const { title, description } = options.parsedData || {};
          const metadataFiles = get(metadata.objects, 'files', []);
          const files = [...metadataFiles, ...filesList];
          const pr = { ...metadata.pr, head: 'newHead.sha' };
          const objects = {
            entry: { path: entry.path, sha: 'entry.sha' },
            files: uniq(files),
          };
          const updatedMetadata = { ...metadata, pr, title, description, objects };

          /**
           * If an asset store is in use, assets are always accessible, so we
           * can just finish the persist operation here.
           */
          if (options.hasAssetStore) {
            return this.storeMetadata(contentKey, updatedMetadata).then(() =>
              this.patchBranch(branchName, newHead.sha),
            );
          }

          /**
           * If no asset store is in use, assets are being stored in the content
           * repo, which means pull requests opened for editorial workflow
           * entries must be rebased if assets have been added or removed.
           */
          // return this.rebasePullRequest(pr.number, branchName, contentKey, metadata, newHead);
        });
    }
  }

  /**
   * Rebase a pull request onto the latest HEAD of it's target base branch
   * (should generally be the configured backend branch). Only rebases changes
   * in the entry file.
   */
  async rebasePullRequest(prNumber, branchName, contentKey, metadata, head) {
    console.log ('** DEBUG entering rebasePullRequest - prNumber: ' + prNumber );
    const { path } = metadata.objects.entry;

    try {
      /**
       * Get the published branch and create new commits over it. If the pull
       * request is up to date, no rebase will occur.
       */
      const baseBranch = await this.getBranch();
      const commits = await this.getPullRequestCommits(prNumber, head);

      /**
       * Sometimes the list of commits for a pull request isn't updated
       * immediately after the PR branch is patched. There's also the possibility
       * that the branch has changed unexpectedly. We account for both by adding
       * the head if it's missing, or else throwing an error if the PR head is
       * neither the head we expect nor its parent.
       */
      const finalCommits = this.assertHead(commits, head);
      const rebasedHead = await this.rebaseSingleBlobCommits(baseBranch.commit, finalCommits, path);

      /**
       * Update metadata, then force update the pull request branch head.
       */
      const pr = { ...metadata.pr, head: rebasedHead.sha };
      const timeStamp = new Date().toISOString();
      const updatedMetadata = { ...metadata, pr, timeStamp };
      await this.storeMetadata(contentKey, updatedMetadata);
      return this.patchBranch(branchName, rebasedHead.sha, { force: true });
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Rebase an array of commits one-by-one, starting from a given base SHA. Can
   * accept an array of commits as received from the GitHub API. All commits are
   * expected to change the same, single blob.
   */
  rebaseSingleBlobCommits(baseCommit, commits, pathToBlob) {
    console.log ('** DEBUG entering rebaseSingleBlobCommits - baseCommit: ' + baseCommit );
    /**
     * If the parent of the first commit already matches the target base,
     * return commits as is.
     */
    if (commits.length === 0 || commits[0].parents[0].sha === baseCommit.sha) {
      return Promise.resolve(last(commits));
    }

    /**
     * Re-create each commit over the new base, applying each to the previous,
     * changing only the parent SHA and tree for each, but retaining all other
     * info, such as the author/committer data.
     */
    const newHeadPromise = commits.reduce((lastCommitPromise, commit) => {
      return lastCommitPromise.then(newParent => {
        /**
         * Normalize commit data to ensure it's not nested in `commit.commit`.
         */
        const parent = this.normalizeCommit(newParent);
        const commitToRebase = this.normalizeCommit(commit);

        return this.rebaseSingleBlobCommit(parent, commitToRebase, pathToBlob);
      });
    }, Promise.resolve(baseCommit));

    /**
     * Return a promise that resolves when all commits have been created.
     */
    return newHeadPromise;
  }

  /**
   * Rebase a commit that changes a single blob. Also handles updating the tree.
   */
  rebaseSingleBlobCommit(baseCommit, commit, pathToBlob) {
    console.log ('** DEBUG entering rebaseSingleBlobCommit - baseCommit: ' +  baseCommit );
    /**
     * Retain original commit metadata.
     */
    const { message, author, committer } = commit;

    /**
     * Set the base commit as the parent.
     */
    const parent = [baseCommit.sha];

    /**
     * Get the blob data by path.
     */
    return (
      this.getBlobInTree(commit.tree.sha, pathToBlob)

        /**
         * Create a new tree consisting of the base tree and the single updated
         * blob. Use the full path to indicate nesting, GitHub will take care of
         * subtree creation.
         */
        .then(blob => this.createTree(baseCommit.tree.sha, [{ ...blob, path: pathToBlob }]))

        /**
         * Create a new commit with the updated tree and original commit metadata.
         */
        .then(tree => this.createCommit(message, tree.sha, parent, author, committer))
    );
  }

  /**
   * Get a pull request by PR number.
   */
  getPullRequest(prNumber) {
    console.log ('** DEBUG entering getPullRequest - prNumber: ' + prNumber );
    return this.request(`${this.repoURL}/pulls/${prNumber} }`);
  }

  /**
   * Get the list of commits for a given pull request.
   */
  getPullRequestCommits(prNumber) {
    console.log ('** DEBUG entering getPullRequestCommits - prNumber: ' +  prNumber );
    return this.request(`${this.repoURL}/pulls/${prNumber}/commits`);
  }

  /**
   * Returns `commits` with `headToAssert` appended if it's the child of the
   * last commit in `commits`. Returns `commits` unaltered if `headToAssert` is
   * already the last commit in `commits`. Otherwise throws an error.
   */
  assertHead(commits, headToAssert) {
    console.log ('** DEBUG entering assertHead - type: ' );
    const headIsMissing = headToAssert.parents[0].sha === last(commits).sha;
    const headIsNotMissing = headToAssert.sha === last(commits).sha;

    if (headIsMissing) {
      return commits.concat(headToAssert);
    } else if (headIsNotMissing) {
      return commits;
    }

    throw Error('Editorial workflow branch changed unexpectedly.');
  }

  updateUnpublishedEntryStatus(collection, slug, status) {
    console.log ('** DEBUG entering updateUnpublishedEntryStatus - type: ' );
    const contentKey = slug;
    return this.retrieveMetadata(contentKey)
      .then(metadata => ({
        ...metadata,
        status,
      }))
      .then(updatedMetadata => this.storeMetadata(contentKey, updatedMetadata));
  }

  deleteUnpublishedEntry(collection, slug) {
    console.log ('** DEBUG entering deleteUnpublishedEntry - type: ' );
    const contentKey = slug;
    const branchName = this.generateBranchName(contentKey);
    return (
      this.retrieveMetadata(contentKey)
        .then(metadata => this.closePR(metadata.pr))
        .then(() => this.deleteBranch(branchName))
        // If the PR doesn't exist, then this has already been deleted -
        // deletion should be idempotent, so we can consider this a
        // success.
        .catch(err => {
          if (err.message === 'Reference does not exist') {
            return Promise.resolve();
          }
          return Promise.reject(err);
        })
    );
  }

  publishUnpublishedEntry(collection, slug) {
    console.log ('** DEBUG entering publishUnpublishedEntry - collection: ' + collection + ' -- slug: ' + slug );
    const contentKey = slug;
    const branchName = this.generateBranchName(contentKey);
    return this.retrieveMetadata(contentKey)
      .then(metadata => this.mergePR(metadata.pr, metadata.objects))
      .then(() => this.deleteBranch(branchName));
  }

  createRef(type, name, sha) {
    console.log ('** DEBUG entering createRef - type: ' + type + ' -- name: ' + name + ' --sha: ' + sha );
    // return this.request(`${this.repoURL}/git/refs`, {
    // return this.request(`${this.repoURL}/refs`, { // Azure - need to get the CommitId first...
    //     params: { filter: 'meta%2F_netlify_cms'}
    // }).then ( response => {
      return this.request(`${this.repoURL}/pushes`, { // Azure ... then create a new ref item
        method: 'POST',
        body: JSON.stringify({ 
          // ref: `refs/${type}/${name}`, sha
          // refUpdates: [{ name: `refs/${type}/${name}`, oldObjectId: response.objectId }], 
          refUpdates: [{ name: `refs/${type}/${name}`, oldObjectId: "0000000000000000000000000000000000000000" }], 
          commits: [ { comment: "Initial commit." ,
            changes: [ { changeType: "add", item: { path: sha }, 
            newContent: { contentType: "rawtext", 
            content: `{ sha: ${sha}, type: "commit", url: "https://something" }`
          } } ] } ]
         }),
    // });
    })
  }

  patchRef(type, name, sha, opts = {}) {
    console.log ('** DEBUG entering patchRef - type: ' + type + ' -- name: ' + name + ' --sha: ' + sha + ' --opts: ' + JSON.stringify(opts));
    const force = opts.force || false;
    // return this.request(`${this.repoURL}/git/refs`, {
    return this.request(`${this.repoURL}/refs`, { // Azure - need to get the CommitId first...
         params: { filter: `${type}/${name}`}
     }).then ( response => {
      return this.request(`${this.repoURL}/pushes`, { // Azure ... then create a new ref item
        method: 'POST',
        body: JSON.stringify({ 
          // ref: `refs/${type}/${name}`, sha
          refUpdates: [{ name: `refs/${type}/${name}`, oldObjectId: response.objectId }], 
          commits: [ { comment: "object update" ,
            changes: [ { changeType: "edit", item: { path: sha }, 
            newContent: { contentType: "rawtext", 
            content: `{ sha: ${sha}, type: "commit", url: "https://something" }`
          } } ] } ]
        }),
     });
    }).catch(err => {
      console.log ('** DEBUG ERR in patchRef - error: ' + JSON.stringify(err));
      throw Error('caught err in patchRef');
    })
  }

  deleteRefGH(type, name) {
    console.log ('** DEBUG entering deleteRef - type: ' + type + ' -- name: ' + name  );
    return this.request(`${this.repoURL}/refs`, { // Azure - need to get the CommitId first...
         params: { filter: `${type}/${name}`}
     }).then ( response => {
      return this.request(`${this.repoURL}/pushed`, { // Azure ... then del ref item
        method: 'POST',
        body: JSON.stringify({ 
          // ref: `refs/${type}/${name}`, sha
          refUpdates: [{ name: `refs/${type}/${name}`, oldObjectId: response.objectId }], 
          commits: [ { comment: "object delete" ,
            changes: [ { changeType: "delete", item: { path: sha }, 
          } ] } ]
        }),
     });
    }).catch(err => {
      console.log ('** DEBUG ERR in patchRef - error: ' + JSON.stringify(err));
      throw Error('caught err in patchRef');
    })
  }

  patchRefGH(type, name, sha, opts = {}) {
    console.log ('** DEBUG entering patchRef - type: ' + type + ' -- name: ' + name + ' --sha: ' + sha + ' --opts: ' + JSON.stringify(opts));
    const force = opts.force || false;
    return this.request(`${this.repoURL}/git/refs/${type}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha, force }),
    });
  }

  deleteRefGH(type, name) {
    console.log ('** DEBUG entering deleteRef - type: ' + type + ' -- name: ' + name  );
    return this.request(`${this.repoURL}/git/refs/${type}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  getBranch(branch = this.branch) {
    console.log ('** DEBUG entering getBranch - branch: ' + branch );
    return this.request(`${this.repoURL}/branches/${encodeURIComponent(branch)}`);
  }

  createBranch(branchName, sha) {
    console.log ('** DEBUG entering createBranch - branchName: ' + branchName + ' -- sha: ' + sha );
    return this.createRef('heads', branchName, sha);
  }

  assertCmsBranch(branchName) {
    console.log ('** DEBUG entering ssertCmsBranch - branchName: ' + branchName  );
    return branchName.startsWith(CMS_BRANCH_PREFIX);
  }

  patchBranch(branchName, sha, opts = {}) {
    console.log ('** DEBUG entering createBranch - branchName: ' + branchName + ' -- sha: ' + sha + ' -- opts: ' + JSON.stringify(opts) );
    const force = opts.force || false;
    if (force && !this.assertCmsBranch(branchName)) {
      throw Error(`Only CMS branches can be force updated, cannot force update ${branchName}`);
    }
    return this.patchRef('heads', branchName, sha, { force });
  }

  deleteBranch(branchName) {
    console.log ('** DEBUG entering deleteBranch - branchName: ' + branchName  );
    return this.deleteRef('heads', branchName);
  }

  createPR(title, head, base = this.branch) {
    const body = 'Automatically generated by Netlify CMS';
    return this.request(`${this.repoURL}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, body, head, base }),
    });
  }

  closePR(pullrequest) {
    const prNumber = pullrequest.number;
    console.log('%c Deleting PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.repoURL}/pulls/${prNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: closed,
      }),
    });
  }

  mergePR(pullrequest, objects) {
    const headSha = pullrequest.head;
    const prNumber = pullrequest.number;
    console.log('%c Merging PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.repoURL}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        commit_message: 'Automatically generated. Merged on Netlify CMS.',
        sha: headSha,
        merge_method: this.merge_method,
      }),
    }).catch(error => {
      if (error instanceof APIError && error.status === 405) {
        return this.forceMergePR(pullrequest, objects);
      } else {
        throw error;
      }
    });
  }

  forceMergePR(pullrequest, objects) {
    const files = objects.files.concat(objects.entry);
    const fileTree = this.composeFileTree(files);
    let commitMessage = 'Automatically generated. Merged on Netlify CMS\n\nForce merge of:';
    files.forEach(file => {
      commitMessage += `\n* "${file.path}"`;
    });
    console.log(
      '%c Automatic merge not possible - Forcing merge.',
      'line-height: 30px;text-align: center;font-weight: bold',
    );
    return this.getBranch()
      .then(branchData => this.updateTree(branchData.commit.sha, '/', fileTree))
      .then(changeTree => this.commit(commitMessage, changeTree))
      .then(response => this.patchBranch(this.branch, response.sha));
  }

  getTree(sha) {
    if (sha) {
      return this.request(`${this.repoURL}/git/trees/${sha}`);
    }
    return Promise.resolve({ tree: [] });
  }

  /**
   * Get a blob from a tree. Requests individual subtrees recursively if blob is
   * nested within one or more directories.
   */
  getBlobInTree(treeSha, pathToBlob) {
    const pathSegments = pathToBlob.split('/').filter(val => val);
    const directories = pathSegments.slice(0, -1);
    const filename = pathSegments.slice(-1)[0];
    const baseTree = this.getTree(treeSha);
    const subTreePromise = directories.reduce((treePromise, segment) => {
      return treePromise.then(tree => {
        const subTreeSha = find(tree.tree, { path: segment }).sha;
        return this.getTree(subTreeSha);
      });
    }, baseTree);
    return subTreePromise.then(subTree => find(subTree.tree, { path: filename }));
  }

  toBase64(str) {
    return Promise.resolve(Base64.encode(str));
  }

  uploadBlobAzure(item, commitMsg = "no info", branchName  ) {
    console.log('** DEBUG entering uploadBlobAzure item: ' + JSON.stringify(item));
    const content = result(item, 'toBase64', partial(this.toBase64, item.raw));
    const branch = (typeof branchName  === "undefined") ? this.generateBranchName(item.slug) : branchName;
    let changeType ;
    let refsheads ;
    let commitId;
    
    // check if we already have an edited version in a cms-branch 
    return this.getAzureId( item.path, branch )
    .then ( azureIds => {
      console.log('** DEBUG inside uploadBlobAzure azureIds: ' + JSON.stringify(azureIds));
      if (typeof azureIds.commitId  === "undefined") {
        changeType = "add"; commitId = "0000000000000000000000000000000000000000";
      }  else {
        changeType = "edit"; commitId = azureIds.commitId;      
      }
      refsheads = `refs/heads/${branch}`;
    // })
      // adjust commitId in special case that branch == meta and branch already exists
      // CAUTION - the following call should be "await"
      console.log('** DEBUG inside uploadBlobAzure check to adjust MetaID - branch: ' + branch );
      if ( branch.startsWith('meta')) {
        // commitId = await this.getAzureMetaId();
        commitId =  this.getAzureMetaId();
      }
      content.then(contentBase64 =>
      // this.request(`${this.repoURL}/git/blobs`, {
        this.request(`${this.repoURL}/pushes`, {
          method: 'POST',
        body: JSON.stringify({
          refUpdates: [{ name: refsheads, oldObjectId: commitId }], 
          commits: [ { comment: commitMsg,
            changes: [ { changeType: changeType, item: { path: item.path }, 
            newContent: { contentType: "base64encoded", 
            content: contentBase64
            } } ] } ]
          }),
    }).then(response => {
        item.sha = response.sha;
        item.uploaded = true;
        return item;
      }),
    );
    })
    .catch(err => {
      console.log('** DEBUG inside uploadBlobAzure - catch err: ' + err );
    })
  }


  uploadBlobOld(item) {
    console.log ('** DEBUG entering uploadBlob - item: ' + JSON.stringify(item));
    const content = result(item, 'toBase64', partial(this.toBase64, item.raw));
    const branch =  this.generateBranchName(item.slug);
    const refsheads = 'refs/heads/' + branch;

    // check if we already have an edited version in a cms-branch 
    const azureIds = this.getAzureId( item.path, branch )
    // const azureIds = this.getAzureId( item.path, this.CMS_BRANCH_PREFIX + item.slug )
    // const azureIds = this.getAzureId( item.path, 'cms/' + item.slug )
    .then ( response => {
      console.log ('** DEBUG within uploadBlob - update existing entry: ' + JSON.stringify(response));

      return content.then(contentBase64 =>
        // this.request(`${this.repoURL}/git/blobs`, {
        this.request(`${this.repoURL}/pushes`, {
            method: 'POST',
          body: JSON.stringify({
            refUpdates: [{ name: refsheads, oldObjectId: response.commitId }], 
            commits: [ { comment: "another update." ,
              changes: [ { changeType: "edit", item: { path: item.path }, 
              newContent: { contentType: "rawtext", 
              content: item.raw
              } } ] } ]
            }),
        }).then(response => {
          // item.sha = response.sha; // github
          item.sha = response.objectId; // Azure
          item.uploaded = true;
          return item;
        }),
      );
      })
      .catch(error => {
        console.log ('** DEBUG inside uploadBlob - we dont have an edited version already so create one now: ' + JSON.stringify( error ) );
        // throw new APIError(error.message, responseStatus, 'Azure');
        this.request(`${this.repoURL}/pushes`, {  // Azure
          method: 'POST',
        body: JSON.stringify({
          refUpdates: [{ name: refsheads, oldObjectId:"0000000000000000000000000000000000000000" }], 
          commits: [ { comment: "Initial commit." ,
            changes: [ { changeType: "add", item: { path: item.path }, 
            newContent: { contentType: "rawtext", 
            content: item.raw
            } } ] } ]
        }),
      }).then(response => {
        item.sha = response.objectId; // Azure
        item.uploaded = true;
        return item;
      })
      });
   }

  updateTree(sha, path, fileTree) {
    console.log ('** DEBUG entering updateTree - sha: ' + sha + ' -- path: ' + path + ' --fileTree: ' + JSON.stringify(item));
    // before we do anything else we recursively get the full tree
    return this.getTree(sha).then(tree => {
      let obj;
      let filename;
      let fileOrDir;
      const updates = [];
      const added = {};

      for (let i = 0, len = tree.tree.length; i < len; i++) {
        obj = tree.tree[i];
        if ((fileOrDir = fileTree[obj.path])) {
          // eslint-disable-line no-cond-assign
          added[obj.path] = true;
          if (fileOrDir.file) {
            updates.push({ path: obj.path, mode: obj.mode, type: obj.type, sha: fileOrDir.sha });
          } else {
            updates.push(this.updateTree(obj.sha, obj.path, fileOrDir));
          }
        }
      }
      for (filename in fileTree) {
        fileOrDir = fileTree[filename];
        if (added[filename]) {
          continue;
        }
        updates.push(
          fileOrDir.file
            ? { path: filename, mode: '100644', type: 'blob', sha: fileOrDir.sha }
            : this.updateTree(null, filename, fileOrDir),
        );
      }
      return Promise.all(updates)
        .then(tree => this.createTree(sha, tree))
        .then(response => ({
          path,
          mode: '040000',
          type: 'tree',
          sha: response.sha,
          parentSha: sha,
        }));
    });
  }

  createTree(baseSha, tree) {
    return this.request(`${this.repoURL}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseSha, tree }),
    });
  }

  /**
   * Some GitHub API calls return commit data in a nested `commit` property,
   * with the SHA outside of the nested property, while others return a
   * flatter object with no nested `commit` property. This normalizes a commit
   * to resemble the latter.
   */
  normalizeCommit(commit) {
    if (commit.commit) {
      return { ...commit.commit, sha: commit.sha };
    }
    return commit;
  }

  commit(message, changeTree) {
    const parents = changeTree.parentSha ? [changeTree.parentSha] : [];
    return this.createCommit(message, changeTree.sha, parents);
  }

  createCommit(message, treeSha, parents, author, committer) {
    return this.request(`${this.repoURL}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: treeSha, parents, author, committer }),
    });
  }

  // In Azure we don't always have the SHA resp ID handy
  // this function is to get the ObjectId and CommitId (output)
  // from path and branch (input)
  getAzureId(path, branch = this.branch ) {
    console.log ('** DEBUG entering getAzureId - path: ' + path + ' -- branch: ' + branch );
    return this.request(`${this.repoURL}/items`, {
      params: { version: branch, path: path,
        '$format': "json", versionType: "Branch", versionOptions: "None" } // Azure hardwired to get expected response format   
    }).then ( response => {
      console.log ('** DEBUG within getAzureId - response: ' + JSON.stringify( response ));
      return response;
    })
    .catch(err => {
      console.log ('** DEBUG inside getAzureId - error: ' + err  );
      return err;
    });
  }

  async getAzureMetaId() {
    let commitId;
    return this.request( `${this.repoURL}/refs/heads/meta/_netlify_cms` )
    .then( response => {
      console.log ('** DEBUG within getMetaId - adjust meta response: ' + JSON.stringify( response ));
      if ( response.count > 0 ) { 
        const value = response.value[0] ;
        console.log ('** DEBUG within getMetaId - updated meta commitId: ' + value.objectId );
        commitId = value.objectId;
      } else { commitId = "0" }
      return commitId;
    } )     
  }
}
