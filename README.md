# GITHUB-PKG-NPM

A package used to fetch files from github pkg registry


## Usage


```typescript
import GPN from 'github-pkg-npm'

async function main():Promise<void> {
  const gpn = new GPN({
    scope: process.env.GITHUB_SCOPE,
    token: process.env.GITHUB_TOKEN
  })

  const localPath = await gpn.downloadFile('@heineiuo/github-pkg-npm@0.1.0/package.json')

  console.log(localPath) // /tmp/github-pkg-npm/files/github-pkg-npm/0.1.0/package.json
}

main()

```

## License

MIT License