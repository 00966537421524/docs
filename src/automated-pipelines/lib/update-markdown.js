import walk from 'walk-sync'
import { existsSync, lstatSync, unlinkSync } from 'fs'
import path from 'path'
import { readFile, writeFile, readdir } from 'fs/promises'
import matter from 'gray-matter'
import mkdirp from 'mkdirp'
import rimraf from 'rimraf'
import { difference, isEqual } from 'lodash-es'

import { allVersions } from '../../../lib/all-versions.js'
import getApplicableVersions from '../../../lib/get-applicable-versions.js'

const ROOT_INDEX_FILE = 'content/index.md'
export const MARKDOWN_COMMENT =
  '\n\n<!-- Content after this section is automatically generated -->\n\n'

// Main entrypoint into this module. This function adds, removes, and updates
// versions frontmatter in all directories under the targetDirectory.
export async function updateContentDirectory(targetDirectory, sourceContent, frontmatter) {
  const sourceFiles = Object.keys(sourceContent)
  await createDirectory(targetDirectory)
  await removeMarkdownFiles(targetDirectory, sourceFiles, frontmatter.autogenerated)
  await updateMarkdownFiles(targetDirectory, sourceContent, frontmatter)
}

// Remove markdown files that are no longer in the source data
async function removeMarkdownFiles(targetDirectory, sourceFiles, autogeneratedType) {
  // Copy the autogenerated Markdown files to the target directory
  const autogeneratedFiles = await getAutogeneratedFiles(targetDirectory, autogeneratedType)
  // If the first array contains items that the second array does not,
  // it means that a Markdown page was deleted from the OpenAPI schema
  const filesToRemove = difference(autogeneratedFiles, sourceFiles)
  // Markdown files that need to be deleted
  for (const file of filesToRemove) {
    unlinkSync(file)
  }
}

// Gets a list of all files under targetDirectory that have the
// `autogenerated` frontmatter set to `autogeneratedType`.
async function getAutogeneratedFiles(targetDirectory, autogeneratedType) {
  const files = walk(targetDirectory, {
    includeBasePath: true,
    childDirectories: false,
    globs: ['**/*.md'],
    ignore: ['**/README.md', '**/index.md'],
  })
  return (
    await Promise.all(
      files.map(async (file) => {
        const { data } = matter(await readFile(file, 'utf-8'))
        if (data.autogenerated === autogeneratedType) {
          return file
        }
      })
    )
  ).filter(Boolean)
}

// The `sourceContent` object contains the new content and target file
// path for the Markdown files. Ex:
// { <targetFile>: { data: <frontmatter>, content: <markdownContent> } }
async function updateMarkdownFiles(targetDirectory, sourceContent, frontmatter) {
  for (const [file, newContent] of Object.entries(sourceContent)) {
    await updateMarkdownFile(file, newContent.data, newContent.content)
  }
  // This function recursively updates the index.md files in each
  // of the directories under targetDirectory
  await updateDirectory(targetDirectory, frontmatter)
  // We don't want to update directories that the pipelines don't affect
  // so we make one call to update only only the root index.md file
  // in targetDirectory to prevent any unintended changes
  await updateDirectory(path.dirname(targetDirectory), frontmatter, { rootDirectoryOnly: true })
}

// If the Markdown file already exists on disk, we only update the
// content and version frontmatter to allow writers to manually
// edit the modifiable content of the file. If the Markdown file doesn't
// exists, we create a new Markdown file.
async function updateMarkdownFile(
  file,
  sourceData,
  sourceContent,
  commentDelimiter = MARKDOWN_COMMENT
) {
  if (existsSync(file)) {
    // update only the versions property of the file, assuming
    // the other properties have already been added and edited
    const { data, content } = matter(await readFile(file, 'utf-8'))
    if (isEqual(sourceData.versions, data.versions)) {
      return
    }
    const newData = { ...data }
    // Keep all frontmatter currently in the Markdown file on disk
    // except replace the versions property with the new versions
    newData.versions = sourceData.versions
    const targetContent = content.replace(commentDelimiter, sourceContent)
    await writeFile(file, matter.stringify(targetContent, newData))
  } else {
    await createDirectory(path.dirname(file))
    await writeFile(file, matter.stringify(sourceContent, sourceData))
  }
}

// Recursively walks through the directory structure and updates the
// index.md files to match the disk. Before calling this function
// ensure that the Markdown files have been updated and any files
// that need to be deleted have been removed.
async function updateDirectory(
  directory,
  frontmatter,
  { rootDirectoryOnly = false, shortTitle = false } = {}
) {
  const initialDirectoryListing = await getDirectoryInfo(directory)
  // If there are no children on disk, remove the directory
  if (initialDirectoryListing.directoryContents.length === 0 && !rootDirectoryOnly) {
    rimraf(directory)
    return
  }

  // Recursively update child directories
  if (!rootDirectoryOnly) {
    await Promise.all(
      initialDirectoryListing.childDirectories.map(async (subDirectory) => {
        await updateDirectory(`${directory}/${subDirectory}`)
      })
    )
  }

  const indexFile = `${directory}/index.md`
  const { data, content } = await getIndexFileContents(indexFile, frontmatter, shortTitle)

  // We need to re-get the directory contents because a recursive call
  // may have removed a directory since the initial directory read.
  const { directoryContents, childDirectories, directoryFiles } = await getDirectoryInfo(directory)

  const { childrenOnDisk, indexChildren } = getChildrenToCompare(
    indexFile,
    directoryContents,
    data.children
  )

  const itemsToAdd = difference(childrenOnDisk, indexChildren)
  const itemsToRemove = difference(indexChildren, childrenOnDisk)
  if (itemsToRemove.length === 0 && itemsToAdd.length === 0) {
    return
  }

  if (!rootDirectoryOnly) {
    // Update the versions in the index.md file to match the directory contents
    directoryFiles.push(...childDirectories.map((dir) => path.join(dir, 'index.md')))
    const newVersions = await getIndexFileVersions(directory, directoryFiles)
    const isVersionEqual = isEqual(newVersions, data.versions)
    if (!isVersionEqual) {
      data.versions = newVersions
    }
  }

  // Update the index.md file contents and write the file to disk
  const dataUpdatedChildren = updateIndexChildren(
    data,
    { itemsToAdd, itemsToRemove },
    isRootIndexFile(indexFile)
  )
  await writeFile(indexFile, matter.stringify(content, dataUpdatedChildren))
}

// Takes the children properties from the index.md file and the
// files/directories on disk and normalizes them to be comparable
// against each other.
// Children properties include a leading slash except when the
// index.md file is the root index.md file. We also want to
// remove the file extension from the files on disk.
function getChildrenToCompare(indexFile, directoryContents, fmChildren) {
  if (!fmChildren) {
    throw new Error(`No children property found in ${indexFile}`)
  }

  const isEarlyAccess = (item) => isRootIndexFile(indexFile) && item === 'early-access'

  // Get the list of children from the directory contents
  const childrenOnDisk = directoryContents
    .map((file) => `${path.basename(file, '.md')}`)
    .filter((item) => !isEarlyAccess(item))

  const indexChildren = fmChildren
    .map((child) => child.replace('/', ''))
    .filter((item) => !isEarlyAccess(item))

  return { childrenOnDisk, indexChildren }
}

// Adds and removes children properties to the index.md file.
// Added properties are appended to the end of the file, because
// order can be manually modified and is not always sorted alphabetically.
function updateIndexChildren(data, childUpdates, rootIndex = false) {
  const { itemsToAdd, itemsToRemove } = childUpdates
  const childPrefix = rootIndex ? '' : '/'
  const children = [...data.children].filter(
    (item) => !itemsToRemove.includes(item.replace('/', ''))
  )
  children.push(...itemsToAdd.map((item) => `${childPrefix}${item}`))
  const updatedData = { ...data }
  updatedData.children = children
  return updatedData
}

// Gets the contents of the index.md file from disk if it exits or
// creates a new index.md file with the default frontmatter.
async function getIndexFileContents(indexFile, frontmatter, shortTitle = false) {
  const directory = path.dirname(indexFile)
  const indexFileContent = {
    data: {
      title: path.basename(directory),
      ...frontmatter,
      children: [],
    },
    content: '',
  }
  if (shortTitle) {
    indexFileContent.data.shortTitle = path.basename(directory)
  }

  return existsSync(indexFile) ? matter(await readFile(indexFile, 'utf-8')) : indexFileContent
}

// Builds the index.md versions frontmatter by consolidating
// the versions from each Markdown file in the directory + the
// index.md files in any subdirectories of directory.
async function getIndexFileVersions(directory, files) {
  const versions = new Set()
  await Promise.all(
    files.map(async (file) => {
      const filepath = path.join(directory, file)
      if (!existsSync(filepath)) {
        throw new Error(
          `File ${filepath} does not exist while assembling directory index.md files to create parent version.`
        )
      }
      const { data } = matter(await readFile(filepath, 'utf-8'))
      if (!data || !data.versions) {
        throw new Error(`Frontmatter in ${filepath} does not contain versions.`)
      }
      const fmVersions = getApplicableVersions(data.versions)
      fmVersions.forEach((version) => versions.add(version))
    })
  )
  const versionArray = [...versions]
  return await convertVersionsToFrontmatter(versionArray)
}

/* Takes a list of versions in the format:
[
  'free-pro-team@latest',
  'enterprise-cloud@latest',
  'enterprise-server@3.3',
  'enterprise-server@3.4',
  'enterprise-server@3.5',
  'enterprise-server@3.6',
  'enterprise-server@3.7',
  'github-ae@latest'
]
and returns the frontmatter equivalent JSON:
{ 
  fpt: '*',
  ghae: '*',
  ghec: '*', 
  ghes: '*' 
}
*/
export async function convertVersionsToFrontmatter(versions) {
  const frontmatterVersions = {}
  const numberedReleases = {}

  // Currently, only GHES is numbered. Number releases have to be
  // handled differently because they use semantic versioning.
  versions.forEach((version) => {
    const docsVersion = allVersions[version]
    if (!docsVersion.hasNumberedReleases) {
      frontmatterVersions[docsVersion.shortName] = '*'
    } else {
      // Each version that has numbered releases in allVersions
      // has a string for the number (currentRelease) and an array
      // of all of the available releases (e.g. ['3.3', '3.4', '3.5'])
      // This creates an array of the applicable releases in the same
      // order as the available releases array. This is used to track when
      // a release is no longer supported.
      const i = docsVersion.releases.sort().indexOf(docsVersion.currentRelease)
      if (!numberedReleases[docsVersion.shortName]) {
        const availableReleases = Array(docsVersion.releases.length).fill(undefined)
        availableReleases[i] = docsVersion.currentRelease
        numberedReleases[docsVersion.shortName] = {
          availableReleases,
        }
      } else {
        numberedReleases[docsVersion.shortName].availableReleases[i] = docsVersion.currentRelease
      }
    }
  })

  // Create semantic versions for numbered releases
  Object.keys(numberedReleases).forEach((key) => {
    const availableReleases = numberedReleases[key].availableReleases
    const versionContinuity = checkVersionContinuity(availableReleases)
    if (availableReleases.every(Boolean)) {
      frontmatterVersions[key] = '*'
    } else if (!versionContinuity) {
      // If there happens to be version gaps, just enumerate each version
      // using syntax like =3.x || =3.x
      const semVer = availableReleases
        .filter(Boolean)
        .map((release) => `=${release}`)
        .join(' || ')
      frontmatterVersions[key] = semVer
    } else {
      const semVer = []
      if (!availableReleases[availableReleases.length - 1]) {
        const endVersion = availableReleases.filter(Boolean).pop()
        semVer.push(`<=${endVersion}`)
      }
      if (!availableReleases[0]) {
        const startVersion = availableReleases.filter(Boolean).shift()
        semVer.push(`>=${startVersion}`)
      }
      frontmatterVersions[key] = semVer.join(' ')
    }
  })
  const sortedFrontmatterVersions = Object.keys(frontmatterVersions)
    .sort()
    .reduce((acc, key) => {
      acc[key] = frontmatterVersions[key]
      return acc
    }, {})
  return sortedFrontmatterVersions
}

// This is uncommon, but we potentially could have the case where an
// article was versioned for say 3.2, not for 3.3, and then again
// versioned for 3.4. This will result in a custom semantic version range
function checkVersionContinuity(versions) {
  const availableVersions = [...versions]

  // values at the beginning or end of the array are not gaps but normal
  // starts and ends of version ranges
  while (!availableVersions[0]) {
    availableVersions.shift()
  }
  while (!availableVersions[availableVersions.length - 1]) {
    availableVersions.pop()
  }
  return availableVersions.every(Boolean)
}

// Returns true if the indexFile is the root index.md file
function isRootIndexFile(indexFile) {
  return indexFile === ROOT_INDEX_FILE
}

// Creates a new directory if it doesn't exist
async function createDirectory(targetDirectory) {
  if (!existsSync(targetDirectory)) {
    await mkdirp(targetDirectory)
  }
}

async function getDirectoryInfo(directory) {
  if (!existsSync(directory)) {
    throw new Error(`Directory ${directory} did not exist when attempting to get directory info.`)
  }
  const directoryContents = (await readdir(directory)).filter(
    (file) => file !== 'README.md' && file !== 'index.md'
  )

  const childDirectories = directoryContents.filter((item) =>
    lstatSync(`${directory}/${item}`).isDirectory()
  )

  const directoryFiles = difference(directoryContents, childDirectories)
  return { directoryContents, directoryFiles, childDirectories }
}
