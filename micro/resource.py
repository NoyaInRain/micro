# micro
# Copyright (C) 2021 micro contributors
#
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU
# Lesser General Public License as published by the Free Software Foundation, either version 3 of
# the License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
# even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public License along with this program.
# If not, see <http://www.gnu.org/licenses/>.

"""Functionality for handling web resources.

.. data:: HandleResourceFunc

   Function of the form ``handle(url, content_type, data, analyzer)`` which processes a web resource
   and returns a description of it. The resource is given by its *url*, *content_type* and content
   *data*. Additionally, the active *analyzer* is available, useful to :meth:`Analyzer.analyze`
   subresources. If the function cannot handle the resource in question, ``None`` is returned. May
   be ``async``.
"""

from __future__ import annotations

from asyncio import get_event_loop
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial
from hashlib import sha256
from html.parser import HTMLParser
from inspect import isawaitable
from io import BytesIO
import mimetypes
from mimetypes import guess_extension, guess_type
from os import listdir
from pathlib import Path
from typing import Awaitable, Callable, Dict, Iterable, List, Optional, Tuple, Union, cast, overload
from urllib.parse import parse_qsl, urljoin, urlsplit

import PIL.Image
from PIL.Image import DecompressionBombError
from PIL.ImageOps import exif_transpose
from PIL.ImageStat import Stat
from tornado.httpclient import HTTPClientError

from . import error
from .core import RewriteFunc
from .error import Error
from .util import Expect, expect_type, str_or_none
from .webapi import CommunicationError, WebAPI, fetch

HandleResourceFunc = Callable[[str, str, bytes, 'Analyzer'],
                              Union[Optional['Resource'], Awaitable[Optional['Resource']]]]

# Skip system defaults to make sure convertion from media type to extension is invertible
mimetypes.init(files=())

@dataclass
class Resource:
    """See :ref:`Resource`."""

    url: str
    content_type: str
    description: str | None = None
    thumbnail: Resource.Thumbnail | None = None

    @dataclass
    class Thumbnail:
        """See :ref:`ResourceThumbnail`."""

        url: str
        color: str

        @staticmethod
        def parse(data: dict[str, object]) -> Resource.Thumbnail:
            """Parse the given JSON *data* into a :class:`Resource.Thumbnail`."""
            return Resource.Thumbnail(Expect.str(data.get('url')), Expect.str(data.get('color')))

        def json(self, *, rewrite: RewriteFunc = None) -> dict[str, object]:
            """Return a JSON representation of the thumbnail."""
            return {'url': rewrite(self.url) if rewrite else self.url, 'color': self.color}

    @staticmethod
    def parse(data: dict[str, object], **args: object) -> Resource:
        """See :meth:`JSONifiableWithParse.parse`."""
        # pylint: disable=unused-argument; part of API
        thumbnail = Expect.opt(Expect.dict(Expect.str))(data.get('thumbnail'))
        return Resource(
            Expect.str(data.get('url')), Expect.str(data.get('content_type')),
            description=Expect.opt(Expect.str)(data.get('description')),
            thumbnail=Resource.Thumbnail.parse(thumbnail) if thumbnail else None)

    def __post__init__(self) -> None:
        if str_or_none(self.url) is None:
            raise error.ValueError('Blank url')
        if str_or_none(self.content_type) is None:
            raise error.ValueError('Blank content_type')
        self.description = str_or_none(self.description) if self.description else None

    def json(self, restricted: bool = False, include: bool = False, *,
             rewrite: RewriteFunc = None) -> dict[str, object]:
        """See :meth:`JSONifiable.json`."""
        # pylint: disable=unused-argument; part of API
        return {
            '__type__': type(self).__name__,
            'url': rewrite(self.url) if rewrite else self.url,
            'content_type': self.content_type,
            'description': self.description,
            'thumbnail': self.thumbnail.json(rewrite=rewrite) if self.thumbnail else None,
            # Compatibility for Resource.image (deprecated since 0.67.0)
            'image': None
        }

@dataclass
class Image(Resource):
    """See :ref:`Image`."""

    @staticmethod
    def parse(data: dict[str, object], **args: object) -> Image:
        resource = Resource.parse(data, **args)
        return Image(resource.url, resource.content_type, description=resource.description,
                     thumbnail=resource.thumbnail)

@dataclass
class Video(Resource):
    """See :ref:`Video`."""

    @staticmethod
    def parse(data: dict[str, object], **args: object) -> Video:
        resource = Resource.parse(data, **args)
        return Video(resource.url, resource.content_type, description=resource.description,
                     thumbnail=resource.thumbnail)

class Analyzer:
    """Web resource analyzer.

    .. attribute:: handlers

       List of web resource handlers to use for analyzing. By default all handlers included with the
       module are enabled.

    .. attribute:: files

       File storage to resolve file URLs.

    .. data:: THUMBNAIL_SIZE

       Maximum generated thumbnail size.
    """

    THUMBNAIL_SIZE = (1280, 720)

    _CACHE_SIZE = 128
    _CACHE_TTL = timedelta(hours=1)

    def __init__(self, *, handlers: list[HandleResourceFunc] = None, files: Files = None) -> None:
        self.handlers = ([handle_image, handle_webpage] if handlers is None
                         else list(handlers)) # type: List[HandleResourceFunc]
        self.files = files
        self._cache: OrderedDict[str, tuple[Resource, datetime]] = OrderedDict()

    async def analyze(self, url: str) -> Resource:
        """Analyze the web resource at *url* and return a description of it.

        *url* is an absolute HTTP(S) URL. If :attr:`files` is set, file URLs are also valid.

        If there is a problem fetching or analyzing the resource, a :exc:`CommunicationError` or
        :exc:`AnalysisError` is raised respectively.

        Results are cached for about one hour.
        """
        try:
            return self._get_cache(url)
        except KeyError:
            pass

        data, content_type, effective_url = await self.fetch(url)
        resource = None
        for handle in self.handlers:
            result = handle(effective_url, content_type, data, self)
            resource = (await cast('Awaitable[Resource | None]', result) if isawaitable(result)
                        else cast('Resource | None', result))
            if resource:
                break
        if not resource:
            resource = Resource(effective_url, content_type)

        self._set_cache(url, resource)
        self._set_cache(resource.url, resource)
        return resource

    async def fetch(self, url: str) -> Tuple[bytes, str, str]:
        """Fetch the web resource at *url*.

        The data, media type and effective URL (after any redirects) are returned.
        """
        if self.files and urlsplit(url).scheme == 'file':
            try:
                data, content_type = await self.files.read(url)
                return data, content_type, url
            except LookupError as e:
                raise NoResourceError(f'No resource at {url}') from e

        try:
            response = await fetch(url)
            return (response.body, response.headers['Content-Type'].split(';', 1)[0],
                    response.effective_url)
        except ValueError as e:
            raise error.ValueError(f'Bad url scheme {url}') from e
        except HTTPClientError as e:
            if e.code in (404, 410):
                raise NoResourceError(f'No resource at {url}') from e
            if e.code in (401, 402, 403, 405, 451):
                raise ForbiddenResourceError(f'Forbidden resource at {url}') from e
            raise CommunicationError(f'Unexpected response status {e.code} for GET {url}') from e

    # @singledispatchmethod is only available in Python >= 3.8
    @overload
    async def thumbnail(self, __data: bytes, __content_type: str) -> Resource.Thumbnail:
        pass
    @overload
    async def thumbnail(self, __url: str) -> Resource.Thumbnail:
        pass
    async def thumbnail(self, data: bytes | str, content_type: str = '') -> Resource.Thumbnail:
        """Generate a thumbnail from image *data*.

        *content_type* is the media type of the image. The generated thumbnail is stored in
        :attr:`files`. If *data* is corrupt, a :exc:`BrokenResourceError` is raised.

        If alternatively an image *url* is given, the image is fetched first. If there is a problem,
        an :exc:`AnalysisError` or :exc:`CommunicationError` is raised.
        """
        if isinstance(data, str):
            data, content_type, _ = await self.fetch(data)
            return await self.thumbnail(data, content_type)
        if not self.files:
            raise ValueError('No files')

        if content_type in {'image/bmp', 'image/gif', 'image/jpeg', 'image/png'}:
            try:
                with PIL.Image.open(BytesIO(data), formats=[content_type[6:]]) as src:
                    image = exif_transpose(src)
                    image.thumbnail(Analyzer.THUMBNAIL_SIZE)
                    if image.mode == 'RGB':
                        r, g, b = cast(tuple[float, float, float], Stat(image).mean)
                        color = f'#{int(r):02x}{int(g):02x}{int(b):02x}'
                    else:
                        # At the moment, transparent (RGBA, LA), grayscale (L, I, 1), CMYK and color
                        # palette (P) images are not handled
                        color = '#ffffff'
                    stream = BytesIO()
                    image.save(stream, format=cast(str, src.format))
                    data = stream.getvalue()
            except DecompressionBombError as e:
                raise BrokenResourceError('Exceeding data size') from e
            except OSError as e:
                raise BrokenResourceError('Bad data') from e
        elif content_type == 'image/svg+xml':
            color = '#ffffff'
        else:
            raise BrokenResourceError(f'Unknown content_type {content_type}')

        url = await self.files.write(data, content_type)
        return Resource.Thumbnail(url, color)

    def _get_cache(self, url: str) -> Resource:
        resource, expires = self._cache[url]
        if datetime.utcnow() >= expires:
            del self._cache[url]
            raise KeyError(url)
        return resource

    def _set_cache(self, url: str, resource: Resource) -> None:
        try:
            del self._cache[url]
        except KeyError:
            pass
        if len(self._cache) == self._CACHE_SIZE:
            self._cache.popitem(last=False)
        self._cache[url] = (resource, datetime.utcnow() + self._CACHE_TTL)

class Files:
    """Simple file storage.

    Note that any method may raise an :exc:`OSError` if there is an IO related problem.

    .. attribute:: path

       Directory where files are stored. Must be read and writable by the current process.
    """

    def __init__(self, path: str) -> None:
        self.path = path

    async def read(self, url: str) -> Tuple[bytes, str]:
        """Read the file at the given file *url* and return the data and media type.

        If there is no file at *url*, a :exc:`LookupError` is raised.
        """
        components = urlsplit(url)
        if components.scheme and components.scheme != 'file':
            raise ValueError(f'Bad url scheme {url}')
        name = components.path.lstrip('/')
        content_type, _ = guess_type(name)
        if '/' in name or not content_type:
            raise LookupError(url)
        try:
            data = await self._load(str(Path(self.path, name)))
        except FileNotFoundError as e:
            raise LookupError(url) from e
        return data, content_type

    async def write(self, data: bytes, content_type: str) -> str:
        """Write *data* to a file and return its file URL.

        *content_type* is the media type, recognized by :mod:`mimetypes`.
        """
        digest = sha256(data).hexdigest()
        ext = guess_extension(content_type)
        if not ext:
            raise ValueError(f'Unknown content_type {content_type}')
        name = f'{digest}{ext}'
        await self._dump(str(Path(self.path, name)), data)
        return f'file:/{name}'

    async def garbage_collect(self, references: Iterable[str] = ()) -> int:
        """Delete files without entry in *references*.

        If *references* is empty (the default), all files are removed. The number of deleted files
        is returned.
        """
        # We could raise an error for dangling references (the implementation does not care),
        # because they indicate a bug on the caller's side
        files = set(await get_event_loop().run_in_executor(None, partial(listdir, self.path)))
        references = {urlsplit(url).path.lstrip('/') for url in references}
        garbage = {str(Path(self.path, name)) for name in files - references}
        await self._unlink(garbage)
        return len(garbage)

    @staticmethod
    async def _load(path: str) -> bytes:
        def _f() -> bytes:
            with open(path, 'rb') as f:
                return f.read()
        return await get_event_loop().run_in_executor(None, _f)

    @staticmethod
    async def _dump(path: str, data: bytes) -> None:
        def _f() -> None:
            with open(path, 'wb') as f:
                f.write(data)
        return await get_event_loop().run_in_executor(None, _f)

    @staticmethod
    async def _unlink(paths: Iterable[str]) -> None:
        def _f() -> None:
            for path in paths:
                Path(path).unlink()
        return await get_event_loop().run_in_executor(None, _f)

async def handle_image(url: str, content_type: str, data: bytes,
                       analyzer: Analyzer) -> Image | None:
    """Process an image resource."""
    # pylint: disable=unused-argument; part of API
    # https://en.wikipedia.org/wiki/Comparison_of_web_browsers#Image_format_support
    if content_type in {'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml'}:
        thumbnail = await analyzer.thumbnail(data, content_type) if analyzer.files else None
        return Image(url, content_type, thumbnail=thumbnail)
    return None

async def handle_webpage(url: str, content_type: str, data: bytes,
                         analyzer: Analyzer) -> Resource | None:
    """Process a webpage resource."""
    if content_type not in {'text/html', 'application/xhtml+xml'}:
        return None

    try:
        html = data.decode()
    except UnicodeDecodeError as e:
        raise BrokenResourceError(f'Bad data encoding analyzing {url}') from e
    parser = _MetaParser()
    parser.feed(html)
    parser.close()

    description = str_or_none(parser.meta.get('og:title') or parser.meta.get('title') or '')
    thumbnail = None
    image_url = (parser.meta.get('og:image') or parser.meta.get('og:image:url') or
                 parser.meta.get('og:image:secure_url'))
    if image_url and analyzer.files:
        try:
            thumbnail = await analyzer.thumbnail(urljoin(url, image_url))
        except error.ValueError as e:
            raise BrokenResourceError(
                f'Bad data image URL scheme {image_url!r} analyzing {url}') from e

    return Resource(url, content_type, description=description, thumbnail=thumbnail)

def handle_youtube(key: str) -> HandleResourceFunc:
    """Return a function which processes a YouTube video.

    *key* is a YouTube API key. Can be retrieved from
    https://console.developers.google.com/apis/credentials.
    """
    youtube = WebAPI('https://www.googleapis.com/youtube/v3/', query={'key': key})

    async def f(url: str, content_type: str, data: bytes, analyzer: Analyzer) -> Resource | None:
        # pylint: disable=unused-argument; part of API
        if not url.startswith('https://www.youtube.com/watch'):
            return None

        video_id = dict(parse_qsl(urlsplit(url).query)).get('v', '')
        result = await youtube.call('GET', 'videos', query={'id': video_id, 'part': 'snippet'})
        try:
            items = expect_type(list)(result['items'])
            if not items:
                return None
            description = expect_type(str)(items[0]['snippet']['title']) # type: ignore
            image_url = expect_type(str)(
                items[0]['snippet']['thumbnails']['high']['url']) # type: ignore
            thumbnail = await analyzer.thumbnail(image_url) if analyzer.files else None
        except (TypeError, LookupError, error.ValueError) as e:
            raise CommunicationError(f'Bad result for GET {youtube.url}videos?id={video_id}') from e
        return Video(url, content_type, description=description, thumbnail=thumbnail)
    return f

class AnalysisError(Error):
    """See :ref:`AnalysisError`."""

class NoResourceError(AnalysisError):
    """See :ref:`NoResourceError`."""

class ForbiddenResourceError(AnalysisError):
    """See :ref:`ForbiddenResourceError`."""

class BrokenResourceError(AnalysisError):
    """See :ref:`BrokenResourceError`."""

class _MetaParser(HTMLParser):
    # pylint: disable=abstract-method; https://bugs.python.org/issue31844

    def __init__(self) -> None:
        super().__init__()
        self.meta = {} # type: Dict[str, str]
        self._read_tag_data = None # type: Optional[str]

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if not self._read_tag_data:
            if tag == 'title':
                self.meta['title'] = ''
                self._read_tag_data = 'title'
            elif tag == 'meta':
                # Consider standard HTML (name) and Open Graph / RDFa (property) tags
                key = next((v for k, v in attrs if k in {'name', 'property'}), None)
                value = next((v for k, v in attrs if k == 'content'), None)
                if key is not None and value is not None:
                    self.meta[key] = value

    def handle_endtag(self, tag: str) -> None:
        if self._read_tag_data == tag:
            self._read_tag_data = None

    def handle_data(self, data: str) -> None:
        if self._read_tag_data:
            self.meta[self._read_tag_data] += data
