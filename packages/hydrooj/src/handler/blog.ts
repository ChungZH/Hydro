import { ObjectID } from 'mongodb';
import { DiscussionNotFoundError } from '../error';
import { BlogDoc } from '../interface';
import paginate from '../lib/paginate';
import * as blog from '../model/blog';
import { PERM, PRIV } from '../model/builtin';
import * as discussion from '../model/discussion';
import * as oplog from '../model/oplog';
import user from '../model/user';
import {
    Handler, param, Route, Types,
} from '../service/server';

class BlogHandler extends Handler {
    ddoc?: BlogDoc;

    @param('did', Types.ObjectID, true)
    async _prepare(domainId: string, did: ObjectID) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        if (did) {
            this.ddoc = await blog.get(did);
            if (!this.ddoc) throw new DiscussionNotFoundError(domainId, did);
        }
    }
}

class BlogUserHandler extends BlogHandler {
    @param('uid', Types.Int)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, uid: number, page = 1) {
        const [ddocs, dpcount] = await paginate(
            blog.getMulti({ owner: uid }),
            page,
            10,
        );
        const udoc = await user.getById(domainId, uid);
        this.response.template = 'blog_main.html';
        this.response.body = {
            ddocs,
            dpcount,
            udoc,
            page,
        };
    }
}

class BlogDetailHandler extends BlogHandler {
    @param('did', Types.ObjectID)
    async get(domainId: string, did: ObjectID) {
        const dsdoc = this.user.hasPriv(PRIV.PRIV_USER_PROFILE)
            ? await blog.getStatus(did, this.user._id)
            : null;
        const udoc = await user.getById(domainId, this.ddoc.owner);
        if (!dsdoc?.view) {
            await Promise.all([
                blog.inc(did, 'views', 1),
                blog.setStatus(did, this.user._id, { view: true }),
            ]);
        }
        this.response.template = 'blog_detail.html';
        this.response.body = {
            ddoc: this.ddoc, dsdoc, udoc,
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    @param('did', Types.ObjectID)
    async postStar(domainId: string, did: ObjectID) {
        await blog.setStar(did, this.user._id, true);
        this.back({ star: true });
    }

    @param('did', Types.ObjectID)
    async postUnstar(domainId: string, did: ObjectID) {
        await blog.setStar(did, this.user._id, false);
        this.back({ star: false });
    }
}

class BlogEditHandler extends BlogHandler {
    async get() {
        this.response.template = 'blog_edit.html';
        this.response.body = { ddoc: this.ddoc };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    async postCreate(domainId: string, title: string, content: string) {
        this.checkPerm(PERM.PERM_CREATE_DISCUSSION);
        await this.limitRate('add_blog', 3600, 60);
        const did = await blog.add(this.user._id, title, content, this.request.ip);
        this.response.body = { did };
        this.response.redirect = this.url('blog_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectID)
    @param('title', Types.Title)
    @param('content', Types.Content)
    async postUpdate(domainId: string, did: ObjectID, title: string, content: string) {
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        else this.checkPerm(PERM.PERM_EDIT_DISCUSSION_SELF);
        await blog.edit(did, title, content);
        await oplog.add({
            ...this.ddoc, operator: this.user._id, type: 'edit',
        });
        this.response.body = { did };
        this.response.redirect = this.url('blog_detail', { uid: this.user._id, did });
    }

    @param('did', Types.ObjectID)
    async postDelete(domainId: string, did: ObjectID) {
        if (!this.user.own(this.ddoc)) this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        else this.checkPerm(PERM.PERM_DELETE_DISCUSSION_SELF);
        await discussion.del(domainId, did);
        await oplog.add({
            ...this.ddoc, operator: this.user._id, operateIp: this.request.ip, type: 'delete',
        });
        this.response.redirect = this.url('blog_main', { uid: this.ddoc.owner });
    }
}

export async function apply() {
    Route('blog_main', '/blog/:uid', BlogUserHandler);
    Route('blog_create', '/blog/:uid/create', BlogEditHandler);
    Route('blog_detail', '/blog/:uid/:did', BlogDetailHandler);
    Route('blog_edit', '/blog/:uid/:did/edit', BlogEditHandler);
}

global.Hydro.handler.blog = apply;