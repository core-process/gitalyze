const child_process = require('child_process');
const _ = require('underscore');
const MongoClient = require('mongodb').MongoClient;
const ArgumentParser = require('argparse').ArgumentParser;
const ProgressBar = require('progress');

function git(args, cwd) {
    return child_process.execSync(`git ${args}`, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
}

async function main(repoPath, remoteName, mongoUri, mongoDb) {
    // defaults
    if (!repoPath) {
        repoPath = '.';
    }

    if (!remoteName) {
        remoteName = 'origin';
    }

    if (!mongoUri) {
        mongoUri = 'mongodb://localhost:27017';
    }

    if (!mongoDb) {
        mongoDb = `gitalyze-${new Date().toISOString().replace(/[\-:\.]/g, '')}`;
    }

    // connect to database
    const client = await MongoClient.connect(mongoUri, { useNewUrlParser: true });
    const collection = client.db(mongoDb).collection('commits');

    // lookup repo name
    var repoUrl = git(`config --get remote.${remoteName}.url`, repoPath);
    var repoName = _.last(repoUrl.split('/'));

    console.log(`Repo: ${repoName}`);

    // fetch remotes
    git(`fetch --all --prune`, repoPath);

    // list all branches
    var branches = git(`branch -r --format='%(refname)'`, repoPath)
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.split('/').length >= 4)
        .filter(l => l.split('/')[2] == remoteName)
        .map(l => l.split('/').slice(3).join('/'))
        .filter(l => l != "HEAD")
        .sort();

    console.log(`${branches.length} branches:\n- ${branches.join("\n- ")}`);

    // lookup all commit hashes
    var commits = new Map();

    for (var branch of branches) {
        git(`rev-list --full-history ${remoteName}/${branch}`, repoPath)
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0)
            .forEach(commitHash => {
                if (commits.has(commitHash)) {
                    commits.get(commitHash).branches.push(branch);
                }
                else {
                    commits.set(commitHash, {
                        repo: repoName,
                        remote: remoteName,
                        hash: commitHash,
                        branches: [branch]
                    });
                }
            });
    }

    console.log(`${commits.size} commits:\n- ${Array.from(commits.keys()).sort().join("\n- ")}`);

    // fetch commit info
    var bar = new ProgressBar(':bar :current/:total', { total: commits.size });

    for (let [commitHash, commitDetails] of commits) {
        // fetch commit meta data
        commitDetails.author = {
            email: git(`show -s --format='%ae' ${commitHash}`, repoPath),
            name: git(`show -s --format='%an' ${commitHash}`, repoPath),
            date: new Date(git(`show -s --format='%ai' ${commitHash}`, repoPath)),
        };
        commitDetails.committer = {
            email: git(`show -s --format='%ce' ${commitHash}`, repoPath),
            name: git(`show -s --format='%cn' ${commitHash}`, repoPath),
            date: new Date(git(`show -s --format='%ci' ${commitHash}`, repoPath)),
        };
        commitDetails.subject = git(`show -s --format='%s' ${commitHash}`, repoPath);
        commitDetails.body = git(`show -s --format='%b' ${commitHash}`, repoPath);

        // check special commits
        commitDetails.isPR = (/^\s*(Merged\s+)?PR\s+\d+:/mi).test(commitDetails.subject);
        commitDetails.isMerge = !commitDetails.isPR && (/Merge/mi).test(commitDetails.subject);

        // generate id
        commitDetails._id = `${commitDetails.repo}-${commitDetails.remote}-${commitDetails.hash}`;

        // fetch commit stats
        commitDetails.stats = {
            file: git(`show --format='' --numstat ${commitHash}`, repoPath)
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0)
                .map(l => l.split('\t').map(i => i.trim()))
                .map(l => ({
                    path: l[2],
                    insertions: /^\d+$/.test(l[0]) ? parseInt(l[0]) : null,
                    deletions: /^\d+$/.test(l[1]) ? parseInt(l[1]) : null
                }))
        };
        commitDetails.stats.total = {
            insertions: commitDetails.stats.file.reduce((i, e) => i + (e.insertions || 0), 0),
            deletions: commitDetails.stats.file.reduce((i, e) => i + (e.deletions || 0), 0)
        };

        // store to database
        await collection.updateOne({
            _id: commitDetails._id
        }, {
                $set: { ...commitDetails }
            }, {
                upsert: true,
                w: "majority",
                j: true
            });

        bar.tick();
    }

    // close database connection
    client.close();
    console.log('Done!');
}

const parser = new ArgumentParser({
    version: '0.9',
    addHelp: true,
    description: 'Analyze your git repositories!'
});

parser.addArgument(
    ['-p', '--repo'],
    {
        help: 'path to repository'
    }
);
parser.addArgument(
    ['-r', '--remote'],
    {
        help: 'git remote, e.g. origin'
    }
);
parser.addArgument(
    ['-d', '--db'],
    {
        help: 'mongo db'
    }
);
parser.addArgument(
    ['-m', '--mongo'],
    {
        help: 'mongo url'
    }
);

const args = parser.parseArgs();

main(args.repo, args.remote, args.mongo, args.db)
    .then(() => { process.exit(0); })
    .catch(error => {
        console.log(error);
        process.exit(1);
    });
